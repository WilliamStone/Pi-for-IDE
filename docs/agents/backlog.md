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

### Pi Sessions 视图 WebviewView 化（0.3.x 原生树之后的演进，用户已确认后置）

原生 TreeView 已交付（byProject/recent 双模式、metaLayout 单双行、
折叠双态、标题截断），但它是天花板明确的容器：无多行节点、无列/
右对齐渲染、宽度对扩展不可见、无内嵌过滤框。当前双行 meta 是
"主行+续行"伪装（label 位 + 透明占位图标 + pi-ide-meta scheme 的
FileDecoration 染暗——同列对齐且暗色，详见 sessions-tree.ts）。

WebviewView 化换来的：真·右缘 meta 列、随宽度自适应、内嵌过滤输入
框（直接服务"找会话"场景）、列头排序、更富状态标。

迁移要点（已探明的代价面）：
- 数据层全保留——provider 从产 TreeItem 改为 postMessage JSON；
  view/title 工具按钮不受影响（view 级贡献照吃 webview 视图）。
- `view/item/context` 的 21 个右键命令够不着 webview——需自建小型
  HTML 菜单，菜单项 → executeCommand（命令本身零改动，when 规则
  重接到 JS）。
- "Reveal in Sessions"：TreeView.reveal 换 scrollIntoView+高亮消息。
- 展开/折叠、键盘导航、ARIA 自建（v1 可简）；折叠双态的"代际 id"
  技巧在 webview 里退化为普通 state。
- 模式沿用 byProject/recent + metaLayout 语义（双行在 webview 里变
  真双行 DOM，不再需要续行伪装）。

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
- webview e2e 三层已成形：`shell.test.mjs`（jsdom 状态机）+
  `bridge.test.mjs`（vscode stub + 真 fs/git）+ `e2e/vscodium.test.mjs`
  （playwright._electron 拉真 VSCodium：装 vsix → 开面板 → 穿透
  index.html/fake.html/pi-web 三层 iframe → 断言 pi-web UI 落地）。
  入口 `npm run test:e2e`，需真显示器，不进 CI 门禁；VSCodium 路径走
  `PI_E2E_VSCODIUM` 环境变量。本 harness 首仗即挖出 ensureStarted
  复用竞态（autoStart 在途实例的 serverReady 带 :0 探针）。
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
