# Pi for IDE — VS Code 扩展

![Pi for IDE 截图](screen.png)

**Pi for IDE** 把 [Pi Web+](https://github.com/WilliamStone/Pi-for-IDE)——pi 编程智能体的 Next.js Web 界面——嵌入 VS Code webview 面板，并叠加一层针对 IDE 工作流的深度集成：不必离开编辑器就能与智能体对话、浏览会话历史、配置模型与技能、审查并回退文件改动。

pi-web 服务器**不随扩展打包**。它作为本地进程由独立安装的 [`@william_stone/pi-web-for-ide`](https://www.npmjs.com/package/@william_stone/pi-web-for-ide) 包提供——该包也可以在普通浏览器里独立运行。扩展与 Web 应用可分别升级。

## 功能

### 1. 嵌入式面板，外置服务

- **解析链**：`executablePath` 设置 → 扩展内置 `resources/` → 全局 npm 包 → PATH shim（`pi-web-for-ide`）→ 托管运行时（扩展可在 globalStorage 里自装自维护一份——不装全局包也能用）。
- **attach 优先**：3030–3039 端口上已有打过补丁的 pi-web 在跑时，面板直接 attach 而不重复起服务。一个服务跨窗口共享，`~/.pi` 数据单一视图。attach 到的端口与 `Pi for IDE.port` 配置不一致时会给出提示。
- **embed 握手**：连接后探测 `GET /api/embed` 并校验协议版本。原版（未打补丁）pi-web、安装不完整、协议不匹配各有明确警告与升级指引——绝不静默失败。
- **端口**：首选 3030，被占用时自动 +1。面板顶部有「**在浏览器中打开**」按钮。
- **pi-web 能力全保留**：会话浏览、Markdown 渲染、工具调用展示、分支导航、SSE 流式输出、i18n、主题。

### 2. 工作区集成

- **文件浏览交还 VS Code**：embed 模式下 pi-web 自带的文件树 / 预览 / worktree 切换器隐藏，由资源管理器与编辑器组承接。
- **`@` 文件提及**：输入框的 `@` 补全走 `vscode.workspace.findFiles`（上限 50 条，仅路径，不发代码内容）。
- **右键提及**：编辑器与资源管理器右键菜单提供「Pi for IDE: Mention This File / Mention This Code」。
- **剪贴板桥接**：跨源 iframe 拿不到 `navigator.clipboard`，复制粘贴改走 `vscode.env.clipboard`。
- **当前文件上下文**：你正在查看的文件以隐藏标记注入系统提示——模型可见、UI 不显示、不落盘到会话文件。输入框下方显示当前文件提示，让你清楚 AI 看着哪个文件。

### 3. 文件审查与一键回退

每轮结束后，「**File review**」卡片列出该轮改动过的文件：

- **Open diff in editor**：原生双侧 `vscode.diff`。before 侧由本轮编辑反放重建；文件在轮后被改动导致重建失败时，降级打开记录的 unified patch 并给出提示。
- **Open file in editor**：直接打开文件。
- **回退此轮**：hover 用户消息 → *Revert*。轮开始时捕获的快照恢复所有改动文件（write 新建的文件会删除），随后删除该轮会话条目、重连 parent 链——回退中间轮不会丢后续轮。操作前二次确认。
- **git 全程只读**：不创建 stash / commit / dangling object，不污染你的仓库。

### 4. 服务生命周期

- `Pi for IDE.autoStart`：扩展激活时后台拉起服务（默认关）。
- **watchdog 自退**：扩展拉起的 server 在完全静默（无心跳、无开着的页面）持续 `autoStopAfterSec`（默认 90s，下限 90——隐藏页签约一分钟才能轮询一次）后自行退出。你在 IDE 外独立启动的实例不受影响。
- `Pi for IDE: Stop Server` 停止本窗口管理的实例。
- **升级安全**：npm 包带 preinstall 守门——服务在跑时装/升包会提前给出停止指引，而不是装到一半报 `os error 32`。

## 命令

| 命令 | 说明 |
|---|---|
| `Pi for IDE: Open` | 打开 Pi for IDE 面板 |
| `Pi for IDE: Show Panel` | 显示面板（已创建时） |
| `Pi for IDE: Start Server` | 启动本地 pi-web 服务 |
| `Pi for IDE: Stop Server` | 停止受管服务 |
| `Pi for IDE: Open in Browser` | 在系统浏览器中打开 |
| `Pi for IDE: Mention This File` | 在输入框提及此文件 |
| `Pi for IDE: Mention This Code` | 提及选中代码 |
| `Pi for IDE: Upgrade Server Component` | 升级 pi-web 包 |
| `Pi for IDE: Manage Server Versions` | 选择用哪份已安装的副本 |

## 设置项

| 设置 | 说明 |
|---|---|
| `Pi for IDE.executablePath` | 服务入口绝对路径（`standalone/server.js` 或 `bin/pi-web.js`）；留空走解析链。 |
| `Pi for IDE.package` | 托管/全局查询用的包名（默认 `@william_stone/pi-web-for-ide`，须含 IDE 补丁构建）。 |
| `Pi for IDE.workspaceRoot` | 传给 pi 会话的 `cwd`；留空用当前工作区文件夹。 |
| `Pi for IDE.openBeside` | 面板开在相邻分栏（默认 `true`）。 |
| `Pi for IDE.port` | 首选起始端口（默认 `3030`）。 |
| `Pi for IDE.autoStart` | 激活即拉起服务（默认 `false`）。 |
| `Pi for IDE.autoStop` | 拉起的 server 静默后自退（默认 `true`）。 |
| `Pi for IDE.autoStopAfterSec` | 静默阈值秒数，下限 90（默认 `90`）。 |
| `Pi for IDE.checkForUpdates` | 每次激活后检查一次 npm 新版（默认 `true`）。 |

## 环境要求

- pi-web 服务来自 `@william_stone/pi-web-for-ide`——自己全局装（`pnpm add -g @william_stone/pi-web-for-ide`），或让扩展的托管运行时首次使用时下载。
- 经 PATH shim 启动的服务需要 Node.js ≥ 22.19；托管/spawn 模式用编辑器内置 Node。

## 限制

- webview iframe 沙箱化：`window.confirm()` / `alert()` / `prompt()` 不可用，确认交互全部走页面内 UI。
- attach 只扫 3030–3039。要强制独占实例，把 `Pi for IDE.port` 配到该区间之外。
- 回退只恢复该轮改动过的文件；轮后你自己的手动编辑不受影响、也不被覆盖。
- `?embed=vscode` 让页面进入宿主模式（隐藏浏览器专属 UI、启用桥），不影响其普通浏览器独立运行。
