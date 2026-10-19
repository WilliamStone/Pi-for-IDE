# Pi for IDE — 产品 backlog

1.0.x 之后的演进项。已落地的设计稿见 `turn-revert.md`（回退语义与影子
存储）、`embed-protocol.md`（生命周期协议）、`managed-runtime.md`。

## 会话区工作区过滤（Devin Agent spaces 式）

pi-web 单页可见所有项目/会话并可并发执行；宿主窗口有明确工作区——
跨工作区操作是常态而非边界（已在 diff/读取路径上踩过两次）。

- **目录过滤**为通用条件：按 cwd 过滤会话列表（精确匹配 / 含子目录
  两档）。
- **"当前 VS Code 工作区"作为目录过滤的预设条件**——本质就是目录
  过滤，宿主把 workspaceFolders 推给页面即可，不引入新概念。
- **多根 workspace**：所有 folder 都参与匹配；会话区可再按具体根
  目录细分（下拉或 chips）。
- **工作区变化刷新**：扩展侧 `onDidChangeWorkspaceFolders` → 桥推送
  更新后的工作区信息 → pi-web 会话区刷新过滤基准。
- **打开非当前工作区的会话/项目时提示确认**（避免误在别的项目里跑
  agent 写文件）。

## 原生嵌入深化（大工程）

- pi-web 的项目/会话边栏拆为 VS Code 原生 TreeView（扩展侧数据源），
  对话流面板支持多开——更接近"Pi 活在 IDE 里"而非"iframe 里的网页"。
- 前置依赖：会话列表/会话操作要有完整桥 API（现在只进不出）。

## 回退/快照演进（详见 turn-revert.md）

- rewind-to-point（前缀截断）与 excise-record（中段手术）语义拆分。
- watcher + shadow store：effect-based 采集，before 持久化——diff
  展示与回退同吃一份存储（Devin 同构：写入时固化而非读取时重建）。
- pi 消息级回退做成 pi 插件（extension 进程内可见 per-session tool
  事件，声明级归属免费），pi-web 侧只留 UI 入口+确认框。
- excise 安全收紧：被删轮位于 fork 子树中段时拒绝（一行检测→400）。

## 运行时健壮性

- `Pi for IDE start timed out (30s)`：standalone 首启时 `/api/embed`
  路由 JIT 编译超了 start() 的 30s 预算——embed 探针与 start 超时
  解耦或延长，否则慢机首启必报。
- webview e2e 半覆盖：`shell.test.mjs`（jsdom 驱动 shell.js 状态机）+
  `bridge.test.mjs`（vscode stub + 真 fs/git 跑 Bridge.handle）已落地；
  未覆盖的是 CSP/webview 真渲染与跨层全链——需要 VSCodium CDP 爬进
  webview iframe 或 Playwright 假宿主两档之一，重且脆，按需再上。
- `runGit` `\"` 拼接：文件名含 `"` 会炸（边缘，已知）。
- readFile/openFile/captureSnapshot 的 cwd 白名单（只读类，可收紧）。

## 发布渠道

- **双商店分发**：MS Marketplace 走 `vsce publish`（vsce 4 已就位，
  OIDC trusted publishing 是 PAT 退役后的新链）；Open VSX 走 `ovsx`
  （独立 CLI，未装）——VSCodium 等用 Eclipse gallery 的宿主吃后者。
  手工 vsix 分发继续保留。

## 会话区其他

- 被回退轮的 subagent 会话文件残留（语义已注明，未实现清理）。
- 无 HEAD 仓库（零 commit）回退/展示全退到快照一路——快照覆盖
  面决定这类仓库的能力上限，shadow store 落地后天然解决。
