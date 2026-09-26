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
async function resolveRepo(context, repoId) {
  const repos = (await context.listRepositories()) || []
  if (repos.length === 0) return null
  if (repoId) return repos.find((r) => r.id === repoId) || null
  return repos[0]
}

/** 按路径前缀找文件所属仓库（用于剪藏落盘后精准重索引） */
async function findRepoByPath(context, filePath) {
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const target = norm(filePath)
  return ((await context.listRepositories()) || []).find((r) => target.startsWith(norm(r.localPath) + '/')) || null
}

/** 网页正文抓取（批次 B 收编 0.9.0）：改走内核 ctx.web 统一材料通道——charset 嗅探转码（GBK 防乱码）、
 *  私网拦截、同域礼貌限速、响应缓存与审计在 WebCrawlerService；本插件不再自持正则提取副本。
 *  @returns {title, content, finalUrl} */
async function fetchAndExtract(url) {
  if (!context || !context.web || typeof context.web.read !== 'function') {
    throw new Error('内核材料通道（ctx.web）不可用，请升级宿主后重试')
  }
  const r = await context.web.read(url)
  return { title: String((r && r.title) || '剪藏页面'), content: String((r && r.content) || ''), finalUrl: String((r && r.finalUrl) || url) }
}

/** 文件写入某仓库目录内时触发该仓库重索引，并验证文档可检索 */
async function reindexIfInRepo(context, filePath, title) {
  const repo = await findRepoByPath(context, filePath)
  if (!repo) {
    if (context.log) context.log(`剪藏 ${title} 落点不在任何仓库内，跳过重索引: ${filePath}`)
    return
  }
  await context.reindexRepository(repo.id)
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const indexed = ((await context.getDocuments(repo.id)) || []).find((d) => norm(d.filePath) === norm(filePath))
  if (!indexed && context.log) context.log(`⚠️ 剪藏已写入 ${filePath}，但重索引后未在仓库「${repo.name}」文档列表中找到它`)
}


// ---- R3-S3 剪藏→翻译联动：MyMemory 免费直翻（自持实现——跨包禁互依，不调 translator）----
// 已知约束：单请求 ≤500 字符（本处截断至 3000）、匿名配额约 5k 字/天/IP、仅英→中方向（剪藏外文场景）
const MM_ENDPOINT = 'https://api.mymemory.translated.net/get'
async function mmTranslate(text, targetLang) {
  const trimmed = String(text || '').trim().slice(0, 3000)
  if (!trimmed) return ''
  const url = MM_ENDPOINT + '?q=' + encodeURIComponent(trimmed) + '&langpair=en|' + encodeURIComponent(targetLang)
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Knomi Clip)' } })
  if (!resp.ok) throw new Error('翻译服务 HTTP ' + resp.status)
  const data = await resp.json()
  const t = data && data.responseData && data.responseData.translatedText
  if (typeof t !== 'string' || !t.trim()) throw new Error('翻译服务返回异常')
  return t
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

  // 空抓取设防：正文过短说明页面疑似动态渲染/反爬，落盘一篇空文档只会误导用户
  if (String(content || '').trim().length < 30) {
    throw new Error('抓取到的正文过短或为空（页面疑似动态渲染或需登录）。可换用：复制页面正文后对小诺说「把这段话存到知识库」。')
  }

  // R3-S3 翻译后入库（可选）：勾选目标语言 → MyMemory 直翻 → 对照节追加（原文全文保留在上）
  const translateLang = String(params?.translate_lang || '').trim()
  let translationSection = ''
  if (translateLang && translateLang !== 'none') {
    const truncated = content.length > 3000
    const translation = await mmTranslate(truncated ? content.slice(0, 3000) : content, translateLang)
    translationSection = [
      '---',
      '',
      '## 译文（' + translateLang + (truncated ? '，截断至前 3000 字符' : '') + '，MyMemory 自动翻译）',
      '',
      translation,
      '',
    ].join('\n')
  }

  // 落盘：dirPath（渲染端传入：目标芯片目录或活动仓库/剪藏）；缺省回退首个仓库 clippings/，再退 ~/.knomi/clips
  let targetDir = String(params?.dirPath || '').trim()
  if (!targetDir) {
    const repo = await resolveRepo(context)
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
    ...(translationSection ? [translationSection] : []),
    '',
  ].join('\n')
  await context.writeFile(filePath, md)
  await reindexIfInRepo(context, filePath, title)
  return { filePath, title }
}

/** frontmatter 双格式解析：宿主索引器存 JSON.stringify(对象)（`{"type":"clip","source":...}`），
 *  兼容旧 YAML 文本行；产出 { isClip, source }。
 *  E2E 实证回归：原查询 LIKE '%type: clip%'（YAML 带空格文本）对 JSON 存储永不命中，剪藏历史页恒为空。 */
function parseClipMeta(frontmatter) {
  const raw = String(frontmatter || '')
  if (!raw) return { isClip: false, source: '' }
  try {
    const fm = JSON.parse(raw)
    if (fm && typeof fm === 'object' && !Array.isArray(fm)) {
      return { isClip: fm.type === 'clip', source: String(fm.source || '').trim() }
    }
  } catch { /* 非 JSON：按旧文本格式解析 */ }
  const mSource = raw.split(/\r?\n/).find((l) => l.trim().startsWith('source:')) || ''
  return { isClip: raw.includes('type: clip'), source: mSource ? mSource.trim().slice(7).trim() : '' }
}

/** nav.entry 页数据入口（ADR-202 Phase 2 第三消费者）：剪藏历史一览（type: clip 的已索引文档） */
async function pageClipHistory() {
  if (!context) throw new Error('剪藏插件未激活')
  const rows = (await context.query(
    `SELECT d.title, d.file_path AS filePath, d.frontmatter AS frontmatter, d.created_at AS createdAt
     FROM documents d WHERE d.frontmatter LIKE '%clip%'
     ORDER BY d.created_at DESC LIMIT 300`,
  )) || []
  const items = []
  for (const r of rows) {
    const meta = parseClipMeta(r.frontmatter)
    if (!meta.isClip) continue
    items.push({
      title: r.title || r.filePath,
      source: meta.source,
      createdAt: r.createdAt ? String(r.createdAt).slice(0, 10) : '',
    })
  }
  return {
    title: '剪藏历史',
    columns: [
      { key: 'title', label: '标题' },
      { key: 'source', label: '来源' },
      { key: 'createdAt', label: '剪藏日期', width: 110 },
    ],
    rows: items,
  }
}

module.exports = {
  id: PLUGIN_ID,
  name: '文本剪藏',
  version: '0.2.4',
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
        {
          key: 'translate_lang', label: '翻译后入库', type: 'select', placeholder: '不翻译', options: [
            { value: 'none', label: '不翻译' },
            { value: 'zh-CN', label: '中文' },
            { value: 'en', label: '英文' },
          ],
        },
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
        const repo = await resolveRepo(ctx, args.repoId)
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
        const indexed = ((await ctx.getDocuments(repo.id)) || []).find((d) => norm(d.filePath) === norm(filePath));

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
        const repos = (await ctx.listRepositories()) || []
        const rows = []
        for (const repo of repos) {
          for (const d of (await ctx.getDocuments(repo.id)) || []) {
            // 路径分隔符归一：Windows 存储为反斜杠，统一按正斜杠判断（修复 list_clippings 在 Windows 恒空）
            const p = String(d.filePath || '').replace(/\\/g, '/')
            if (p.includes('/clippings/') || p.includes('/剪藏/')) {
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
  pageClipHistory,
}
