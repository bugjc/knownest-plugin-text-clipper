'use strict'

/**
 * text-clipper 采集阶段插件
 * 两种剪藏入口，产物统一为带来源 frontmatter 的知识库文档，落库即重索引：
 * 1. 网页剪藏（知识库右上角「剪藏」按钮 → 表单弹窗）：URL → 抓取正文 → Markdown，
 *    不经过 LLM，无 API Key 也能剪藏；入口按钮与面板均由本插件声明
 *    （plugin.json contributions + registerPanel），平台按声明渲染。
 *    B5 出网知情：勾选「翻译后入库」会把正文发送至 MyMemory（境外公共服务）机翻——首次须在
 *    「出网知情确认」选「是」（一次同意记入 storage，此后不再询问）；不翻译则纯本地零出网。
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


// ---- R3-S3 剪藏→翻译联动：MyMemory 免费直翻（0.13.1 起引擎收敛：委托平台共享内核
//      translate-core（沙箱经 knownest.stdlib 注入，与 translator 插件/宿主热键同一实现）——
//      段落感知分块串行，修复旧单请求 3000 字符超 MyMemory ≤500 上限的潜在缺陷；
//      stdlib 是平台通道，不破坏「跨包禁互依」：这里不 require translator，消费的是平台共享件）----
// 已知约束：匿名配额约 5k 字/天/IP、仅英→中方向（剪藏外文场景）、本处截断至 3000
const translateCore = (typeof knownest !== 'undefined' && knownest.stdlib && knownest.stdlib['translate-core']) || null
async function mmTranslate(text, targetLang) {
  if (!translateCore) throw new Error('翻译引擎缺面（FREE_ENGINE_STDLIB_MISSING）：请完整重启应用后重试')
  const trimmed = String(text || '').trim().slice(0, 3000)
  if (!trimmed) return ''
  try {
    return await translateCore.translateChunks(trimmed, { langpair: 'en|' + encodeURIComponent(targetLang), errorPrefix: 'CLIP_TRANSLATE' })
  } catch (e) {
    const msg = String((e && e.message) || e)
    throw new Error(msg.startsWith('CLIP_TRANSLATE_') ? '翻译服务暂不可用（' + msg + '）' : String((e && e.message) || msg))
  }
}

/** 出网知情同意（B5 首次一次性）：storage 键 'consent'/'outbound'（{at}）。翻译后入库=正文发送至
 *  MyMemory（境外公共服务），首次须用户同意，一次同意后不再重复要求。读失败按未同意（fail-closed：
 *  宁可多问一次，不可未告知出境；测试桩可能未注入 ctx.storage） */
async function hasOutboundConsent() {
  try { return !!(await context.storage.get('consent', 'outbound')) } catch { return false }
}

/**
 * 网页剪藏（表单面板的 submit 方法，经 plugin:invoke 调用）。
 * @param {url: string, dirPath?: string} params dirPath 由渲染端 target_dir 字段解析注入
 * @returns {filePath, title, message?} filePath 供渲染端约定式打开（产出落盘即打开）；
 *   去重命中时 filePath=已有产物（约定式打开直达旧文档），message 携带说明
 */
async function saveClip(params) {
  if (!context) throw new Error('剪藏插件未激活')
  const url = String(params?.url || '').trim()
  if (!/^https?:\/\//.test(url)) throw new Error('仅支持 http(s):// 地址')

  const { title, content, finalUrl } = await fetchAndExtract(url)

  // 空抓取设防：正文过短说明页面疑似动态渲染/反爬，落盘一篇空文档只会误导用户
  if (String(content || '').trim().length < 30) {
    throw new Error('抓取到的正文过短或为空（页面疑似动态渲染或需登录）。可换用：复制页面正文后对白泽说「把这段话存到知识库」。')
  }

  // 同源去重（CLIP CL1-4 通道化）：与碎片提炼通道共用规范化 finalUrl 台账——命中且旧产物
  // 仍在 → 不落重复文档，返回已有路径（渲染端约定式打开直达旧文档）。ctx.clip 为可选面
  // （旧宿主缺面=不去重，守卫降级）；「想重新剪」的出口=删除旧文档（命中判定要求产物仍在）。
  // deduped=true 为通用表单结果约定：渲染端以内核词典出词提示「已打开既有文档」
  // （插件运行时文案不新增 zh 串——内核 i18n 冻结计数门禁只许降不许升）
  if (context.clip && typeof context.clip.findDuplicate === 'function') {
    const dup = await context.clip.findDuplicate(finalUrl).catch(() => null)
    if (dup && dup.filePath) {
      return { filePath: dup.filePath, title: dup.title || title, deduped: true }
    }
  }

  // R3-S3 翻译后入库（可选）：勾选目标语言 → MyMemory 直翻 → 对照节追加（原文全文保留在上）。
  // B5 出网知情门（首次一次性同意）：翻译入库=正文出境至 MyMemory（境外公共服务）。仅当用户选择了
  // 翻译入库才校验；未同意（字段非「是」且无同意记录）→ 拒绝落盘并指引（选「是」重试或改「不翻译」
  // 纯本地保存）。宿主表单卡无 warning 分支（warning 会被静默吞掉），按 DeckFormCard 契约走 error 通道
  const translateLang = String(params?.translate_lang || '').trim()
  let translationSection = ''
  if (translateLang && translateLang !== 'none') {
    if (!(String(params?.outbound_consent || '') === '是' || (await hasOutboundConsent()))) {
      return {
        error: '未获得出网同意，本次剪藏未保存：勾选「翻译后入库」会把正文发送至 MyMemory（境外公共服务）做机翻。请在「出网知情确认」选「是」后重试；或将「翻译后入库」改为「不翻译」（仅本地保存，不出网）。',
      }
    }
    const truncated = content.length > 3000
    const translation = await mmTranslate(truncated ? content.slice(0, 3000) : content, translateLang)
    // 原文确已出境 → 落一次性同意记录（{at} 时间戳；此后翻译入库不再重复询问；写失败不阻塞剪藏）
    try { await context.storage.set('consent', 'outbound', { at: new Date().toISOString() }) } catch { /* 同意记录失败不阻塞 */ }
    translationSection = [
      '---',
      '',
      '## 译文（' + translateLang + (truncated ? '，截断至前 3000 字符' : '') + '，MyMemory 自动翻译）',
      '',
      translation,
      '',
    ].join('\n')
  }

  // 落盘：dirPath（渲染端传入：目标芯片目录或活动仓库/剪藏）；缺省回退首个仓库 clippings/，再退 ~/.knownest/clips
  let targetDir = String(params?.dirPath || '').trim()
  if (!targetDir) {
    const repo = await resolveRepo(context)
    targetDir = repo ? `${repo.localPath.replace(/[\\/]+$/, '')}/clippings` : join(homedir(), '.knownest', 'clips')
  }
  const fileName = `${timestamp()}-${sanitizeFileName(title)}.md`
  const filePath = join(targetDir, fileName)
  const md = [
    '---',
    'type: clip',
    // title 入 frontmatter：索引器 documents.title = frontmatter.title || 文件名推导——
    // 不写则历史表/检索列显示带时间戳前缀的文件名（2026-10-22 用户反馈修正）
    `title: ${title}`,
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
  // 反向记账（CLIP CL1-4）：插件页产物入同一本台账，碎片提炼通道同源去重才能看见它。
  // 记账失败不阻塞剪藏主链（与台账 fail-open 语义同向：最坏=放行一次未来重复）
  if (context.clip && typeof context.clip.record === 'function') {
    await context.clip.record(finalUrl, { filePath, title }).catch(() => { /* 记账失败不阻塞 */ })
  }
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

/** nav.entry 页数据入口（ADR-202 Phase 2；2026-09-28 单入口收敛轮升级 v2 复合页）：
 *  顶部「网页剪藏」表单卡（原 modal 表单面板迁入，submitMethod=saveClip，完成后约定式打开）
 *  + 下方「剪藏历史」表格卡（type: clip 的已索引文档）——剪藏的全部动线收进本插件页。
 *  2026-10-22 走查批：行点击 openKey 打开产物（FR-168 阅读意图默认预览）；来源列 link
 *  化（系统浏览器打开原网页）。 */
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
      filePath: r.filePath,
      createdAt: r.createdAt ? String(r.createdAt).slice(0, 10) : '',
    })
  }
  return {
    title: '剪藏',
    cards: [
      {
        type: 'form',
        title: '网页剪藏',
        hint: '输入网页地址，Knownest 将抓取正文并保存为 Markdown 文档（本地存储，无需 AI 服务），完成即在编辑器打开。「翻译后入库」会把正文发送至 MyMemory（境外公共服务）做机翻：「出网知情确认」选「是」即同意出境（一次同意，此后不再询问）；不想出境请保持「否」或改选「不翻译」（仅本地保存，不出网）。',
        fields: [
          { key: 'url', label: '网页地址', type: 'text', placeholder: 'https://example.com/article', required: true },
          {
            key: 'translate_lang', label: '翻译后入库', type: 'select', placeholder: '不翻译', options: [
              { value: 'none', label: '不翻译' },
              { value: 'zh-CN', label: '中文' },
              { value: 'en', label: '英文' },
            ],
          },
          // B5 出网知情确认（首次一次性同意；仅约束「翻译后入库」的 MyMemory 出境，不翻译=纯本地零出网）
          { key: 'outbound_consent', label: '出网知情确认', type: 'select', defaultValue: (await hasOutboundConsent()) ? '是' : '否', options: [{ value: '是', label: '是' }, { value: '否', label: '否' }] },
          { key: 'dirPath', label: '保存到（可选目录，留空=活动仓库 clippings/）', type: 'text', placeholder: 'D:/notes/clippings' },
        ],
        submitLabel: '剪藏并打开',
        submitMethod: 'saveClip',
      },
      {
        type: 'table',
        title: '剪藏历史',
      columns: [
        { key: 'title', label: '标题', sortable: 'text' },
        { key: 'source', label: '来源', sortable: 'text', link: true, ellipsis: true },
        { key: 'createdAt', label: '剪藏日期', width: 110, sortable: 'text' },
      ],
      rows: items,
      // 行点击打开产物文档（openKey 契约=编辑器预览）；来源列点击走 link 不冒泡，两不干扰
      openKey: 'filePath',
      // 默认序=SQL created_at DESC（v2.9 orderBy 契约声明化；无日期行沉底；行无唯一键，G1 提示知悉接受）
      orderBy: [{ key: 'createdAt', order: 'desc' }],
      },
    ],
  }
}

module.exports = {
  id: PLUGIN_ID,
  name: '文本剪藏',
  // 版本权威=plugin.json（本轮 0.14.0 走查批对齐：历史表行点击打开/来源链接化/frontmatter
  // title/同源去重接台账）
  version: '0.14.0',
  description: '网页剪藏 + 文本剪藏：抓取网页正文或收藏任意文本为知识库文档，自动重索引立即可查',

  activate(ctx) {
    context = ctx

    // 2026-09-28 单入口收敛：clipper.form 声明式表单面板（modal 承载）已退役——
    // 网页剪藏表单迁入本插件页（pageClipHistory v2 表单卡），全局工作面不再挂载插件入口。

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
          `title: ${args.title}`,
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
