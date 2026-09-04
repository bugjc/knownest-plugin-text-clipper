# 文本剪藏

网页剪藏 + 文本剪藏：抓取网页正文或收藏任意文本为知识库文档，自动重索引立即可查

- 插件 ID：`text-clipper`
- 版本：v0.2.0
- 权限声明：file:read、file:write、db:read、db:write、agent:tools

## 能力

- **网页剪藏**：知识库右上角「剪藏」按钮 → 表单弹窗输入 URL → 抓取正文保存为 Markdown（本地存储，无需 AI 服务），落点在仓库内时自动重索引并打开文档
- **文本剪藏**：Agent 工具 `clip_text` 把任意文本剪藏为仓库 `clippings/` 草稿文档，自动重索引立即可查、可出题、可进图谱
- **剪藏回顾**：Agent 工具 `list_clippings` 列出已采集内容

## 安装

Knomi 插件页「社区市场」扫描安装（topic: knomi-plugin），或在「更多安装方式」中粘贴本仓库地址。

## 更新日志

- v0.2.0：合并网页剪藏入口（workspace.action 贡献 + 表单面板 + URL 抓取），落仓库内自动重索引
- v0.1.0：文本剪藏（clip_text / list_clippings）
