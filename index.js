'use strict'

/**
 * text-clipper 采集阶段插件
 * 把任意文本（网页摘录、聊天结论、灵感）剪藏为知识库草稿文档：
 * 写入仓库 clippings/ 目录（带来源 frontmatter）→ 触发重索引 → 立即可在编辑器/图谱中查到。
 */

const PLUGIN_ID = 'text-clipper'

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

module.exports = {
  id: PLUGIN_ID,
  name: '文本剪藏',
  version: '0.1.0',
  description: '采集阶段：把任意文本剪藏为知识库草稿文档，自动重索引立即可查',

  activate(context) {
    context.registerAgentTool(
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
        const repo = resolveRepo(context, args.repoId)
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
        await context.writeFile(filePath, md)
        await context.reindexRepository(repo.id)

        // 验证：重索引后文档应能被知识库检索到（路径规范化比较，避免分隔符差异误报）
        const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
        const indexed = (context.getDocuments(repo.id) || []).find((d) => norm(d.filePath) === norm(filePath));

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

    context.registerAgentTool(
      {
        name: 'list_clippings',
        description: '列出通过文本剪藏收集的所有文档（clippings 目录）。用于回顾采集了哪些内容。',
        parameters: { type: 'object', properties: {} }
      },
      async () => {
        const repos = context.listRepositories() || []
        const rows = []
        for (const repo of repos) {
          for (const d of context.getDocuments(repo.id) || []) {
            if (String(d.filePath || '').includes('/clippings/')) {
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

  deactivate() {}
}
