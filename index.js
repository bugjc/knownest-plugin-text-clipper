'use strict'

/**
 * text-clipper 采集阶段插件
 * 两种剪藏入口，产物统一为带来源 frontmatter 的知识库文档，落库即重索引：
 * 1. 网页剪藏（知识库右上角「剪藏」按钮 → 表单弹窗）：URL → 抓取正文 → Markdown，
 *    不经过 LLM，无 API Key 也能剪藏；入口按钮与面板均由本插件声明
 *    （plugin.json contributions + registerPanel），平台按声明渲染。
 * 2. 文本剪藏（Agent 工具 clip_text）：把任意文本（网页摘录、聊天结论、灵感）写入
 *    仓库 clippings/ 目录 → 触发重索引 → 立即可在编辑器/图谱中查到。
 */

const { join } = require('path')
const { homedir } = require('os')

const PLUGIN_ID = 'text-clipper'

let context = null

function sanitizeFileName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return cleaned || 'clip'
}

function timestamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 解析目标仓库（repoId 缺省取第一个） */
function resolveRepo(context, repoId) {
  const repos = context.listRepositories() || []
  if (repos.length === 0) return null
  if (repoId) return repos.find((r) => r.id === repoId) || null
  return repos[0]
}

/** 按路径前缀找文件所属仓库（用于剪藏落盘后精准重索引） */
function findRepoByPath(context, filePath) {
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const target = norm(filePath)
  return (context.listRepositories() || []).find((r) => target.startsWith(norm(r.localPath) + '/')) || null
}

/**
 * 抓取网页正文并转为 Markdown（简易 HTML 提取，不依赖外部服务）。
 * @returns {title, content, finalUrl}
 */
async function fetchAndExtract(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  let html = ''
  let finalUrl = url
  try {
    const resp = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Knomi Clip)' } })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    finalUrl = resp.url || url
    html = await resp.text()
  } finally {
    clearTimeout(timer)
  }
  if (html.length > 2 * 1024 * 1024) html = html.substring(0, 2 * 1024 * 1024)

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  const title = titleMatch ? titleMatch[1].trim().replace(/\s+/g, ' ') : '剪藏页面'
  const content = html
    // 剥离脚本/样式/导航/页脚
    .replace(/<(script|style|nav|footer|header|aside|form|iframe|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // 块级标签 → 换行
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<h[1-6][^>]*>/gi, '## ')
    // 去标签
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, content: content.substring(0, 60000), finalUrl }
}

/** 文件写入某仓库目录内时触发该仓库重索引，并验证文档可检索 */
async function reindexIfInRepo(context, filePath, title) {
  const repo = findRepoByPath(context, filePath)
  if (!repo) {
    if (context.log) context.log(`剪藏 ${title} 落点不在任何仓库内，跳过重索引: ${filePath}`)
    return
  }
  await context.reindexRepository(repo.id)
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const indexed = (context.getDocuments(repo.id) || []).find((d) => norm(d.filePath) === norm(filePath))
  if (!indexed && context.log) context.log(`⚠️ 剪藏已写入 ${filePath}，但重索引后未在仓库「${repo.name}」文档列表中找到它`)
}

/**
 * 网页剪藏（表单面板的 submit 方法，经 plugin:invoke 调用）。
 * @param {url: string, dirPath?: string} params dirPath 由渲染端 target_dir 字段解析注入
 * @returns {filePath, title} filePath 供渲染端约定式打开（产出落盘即打开）
 */
async function saveClip(params) {
  if (!context) throw new Error('剪藏插件未激活')
  const url = String(params?.url || '').trim()
  if (!/^https?:\/\//.test(url)) throw new Error('仅支持 http(s):// 地址')

  const { title, content, finalUrl } = await fetchAndExtract(url)

  // 落盘：dirPath（渲染端传入：目标芯片目录或活动仓库/剪藏）；缺省回退首个仓库 clippings/，再退 ~/.knomi/clips
  let targetDir = String(params?.dirPath || '').trim()
  if (!targetDir) {
    const repo = resolveRepo(context)
    targetDir = repo ? `${repo.localPath.replace(/[\\/]+$/, '')}/clippings` : join(homedir(), '.knomi', 'clips')
  }
  const fileName = `${timestamp()}-${sanitizeFileName(title)}.md`
  const filePath = join(targetDir, fileName)
  const md = [
    '---',
    'type: clip',
    `clipped-at: ${new Date().toISOString()}`,
    `source: ${finalUrl}`,
    '---',
    '',
    `# ${title}`,
    '',
    `> 来源：<${finalUrl}>`,
    '',
    content,
    '',
  ].join('\n')
  await context.writeFile(filePath, md)
  await reindexIfInRepo(context, filePath, title)
  return { filePath, title }
}

module.exports = {
  id: PLUGIN_ID,
  name: '文本剪藏',
  version: '0.2.0',
  description: '网页剪藏 + 文本剪藏：抓取网页正文或收藏任意文本为知识库文档，自动重索引立即可查',

  activate(ctx) {
    context = ctx

    // 声明交互面板：网页剪藏表单（声明式 view=form，平台通用表单弹窗渲染）
    ctx.registerPanel({
      id: 'clipper.form',
      label: '网页剪藏',
      surface: 'modal',
      view: 'form',
      hint: '输入网页地址，Knomi 将抓取正文并保存为 Markdown 文档（本地存储，无需 AI 服务）。',
      fields: [
        { key: 'url', label: '网页地址', type: 'text', placeholder: 'https://example.com/article', required: true },
        { key: 'dirPath', label: '保存到', type: 'target_dir' },
      ],
      submitLabel: '剪藏并打开',
      submit: 'saveClip',
    })

    ctx.registerAgentTool(
      {
        name: 'clip_text',
        description: '把一段文本剪藏为知识库文档（存入仓库 clippings/ 目录，带来源 frontmatter），并自动重建索引使其立即可查、可出题、可进图谱。用户说"收藏/剪藏/存一段话/记一下"时使用。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '文档标题（将作为文件名）' },
            content: { type: 'string', description: '要保存的正文（Markdown）' },
            tags: { type: 'array', items: { type: 'string' }, description: '可选标签' },
            sourceUrl: { type: 'string', description: '可选：来源 URL 或出处说明' },
            repoId: { type: 'string', description: '可选：目标仓库 ID，缺省取第一个仓库' }
          },
          required: ['title', 'content']
        }
      },
      async (args) => {
        const repo = resolveRepo(ctx, args.repoId)
        if (!repo) return { output: '', error: '没有可用仓库：请先在「仓库管理」添加至少一个仓库' }

        const tagLine = Array.isArray(args.tags) && args.tags.length > 0
          ? `tags: [${args.tags.map((t) => String(t)).join(', ')}]\n`
          : ''
        const sourceLine = args.sourceUrl ? `source: ${String(args.sourceUrl)}\n` : ''
        const md = [
          '---',
          'type: clip',
          `clipped-at: ${new Date().toISOString()}`,
          sourceLine + tagLine + '---',
          '',
          `# ${args.title}`,
          '',
          String(args.content).trim(),
          ''
        ].join('\n')

        const filePath = `${repo.localPath.replace(/[\\/]+$/, '')}/clippings/${timestamp()}-${sanitizeFileName(args.title)}.md`
        await ctx.writeFile(filePath, md)
        await ctx.reindexRepository(repo.id)

        // 验证：重索引后文档应能被知识库检索到（路径规范化比较，避免分隔符差异误报）
        const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
        const indexed = (ctx.getDocuments(repo.id) || []).find((d) => norm(d.filePath) === norm(filePath));

        return {
          output: indexed
            ? `✅ 已剪藏并完成索引：《${args.title}》\n路径: ${filePath}\n已可被搜索、出题与图谱关联。`
            : `⚠️ 文件已写入 ${filePath}，但重索引后未在文档列表中找到它，请检查仓库路径配置。`,
          ui: indexed
            ? { intent: 'open_document', filePath }
            : { intent: 'notify', type: 'warning', message: '剪藏文件已写入，但索引验证未通过' }
        }
      }
    )

    ctx.registerAgentTool(
      {
        name: 'list_clippings',
        description: '列出通过文本剪藏收集的所有文档（clippings 目录）。用于回顾采集了哪些内容。',
        parameters: { type: 'object', properties: {} }
      },
      async () => {
        const repos = ctx.listRepositories() || []
        const rows = []
        for (const repo of repos) {
          for (const d of ctx.getDocuments(repo.id) || []) {
            if (String(d.filePath || '').includes('/clippings/') || String(d.filePath || '').includes('/剪藏/')) {
              rows.push({ title: d.title || d.filePath, repo: repo.name || repo.id, path: d.filePath })
            }
          }
        }
        if (rows.length === 0) return { output: '还没有任何剪藏。用 clip_text 收藏你的第一段内容吧。' }
        return {
          output: `共有 ${rows.length} 条剪藏：\n${rows.map((r) => `- 《${r.title}》(${r.repo})`).join('\n')}`,
          ui: { intent: 'show_view', view: { title: '剪藏收集箱', columns: [
            { key: 'title', label: '标题' }, { key: 'repo', label: '仓库' }, { key: 'path', label: '路径' }
          ], rows } }
        }
      }
    )
  },

  deactivate() {
    context = null
  },

  saveClip,
}
