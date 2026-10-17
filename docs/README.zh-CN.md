# Pi for IDE / Pi Web+

[English](../README.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

把 [pi 智能体](https://github.com/earendil-works/pi) 的 Web 界面作为一等面板嵌入 VSCode/VSCodium，并叠加一层面向 IDE 工作流的集成能力。

本仓库产出两个可独立安装、独立更新的产物：

| 产物 | 名称 | 角色 |
|---|---|---|
| VSCode 扩展 | **`pi-for-ide`**（`WilliamStone.pi-for-ide`） | **主体**。轻量宿主壳（~190KB）：拉起/连接 pi-web 服务器，在 webview 内叠加 IDE 集成。 |
| npm 包 | **`@william_stone/pi-web-for-ide`** | 底座。pi-web + IDE 适配层；被宿主以 `?embed=<host>` 嵌入时激活 IDE 能力，否则仍提供原版能力。CLI 命令：`pi-web-for-ide`（刻意区别于上游 `pi-web`，两者可共存）。 |

两者的关系：`@william_stone/pi-web-for-ide` 就是"pi-web + 一层宿主适配"，独立运行时与原版 pi-web 无异（品牌位显示 **Pi Web+**）；IDE 特性只在嵌入模式下激活。扩展本身不再携带 pi-web——pi-web 单独安装、单独升级，扩展只负责拉起与桥接。

## IDE 集成（本项目的主体功能）

以下能力只在 VSCode/VSCodium 内以 `?embed=vscode` 嵌入时激活：

- **`@` 文件提及**：补全走 `vscode.workspace.findFiles`，按工作区索引而不是服务器文件系统
- **右键提及**：资源管理器/编辑器右键「Pi for IDE 提及」文件与选中代码段
- **活动文件上下文注入**：正在查看的文件以隐藏 marker 注入 system prompt（AI 可见、UI 不显示、不落盘）
- **文件审查卡片 + inline diff + 一键回退**：每轮列出 AI 改动文件；回退恢复代码并删除该轮记录——只读 git，不产生 stash/commit
- **剪贴板桥接**：沙箱 iframe 里的复制/粘贴改走 `vscode.env.clipboard`
- **界面裁剪**：内置文件树/预览面板在宿主模式下隐藏，交还 VSCode 资源管理器与编辑器组

pi-web 本体的能力（会话管理、流式对话、模型/OAuth/MCP/技能/插件配置、终端、i18n、主题、PWA）全部保留，独立与嵌入模式都可用。

## 安装与使用

要求 Node.js ≥ 22.19.0。

**第一步：全局安装 @william_stone/pi-web-for-ide（推荐 pnpm）：**

```bash
pnpm add -g @william_stone/pi-web-for-ide   # 也可用 npm i -g；本地包：pnpm i -g ./pi-web-for-ide-0.12.1.tgz
```

> 推荐 pnpm 的原因：它装完会列出待批准的构建脚本并可交互勾选确认（`pnpm approve-builds`）——包的 postinstall 要把 standalone 外部包接成 junction；npm 的脚本拦截则没有对应入口。被拦了也有兜底：`pi-web` 启动时会自检补链（≥0.12.2），见 `docs/vscode-extension-deploy.md` 排障节。

**第二步：安装扩展并打开：**

```powershell
code --install-extension vscode-extension/pi-for-ide-0.1.0.vsix    # VSCodium 用 codium
```

然后点状态栏 **Pi for IDE** 按钮，或命令面板执行 **Pi for IDE: Open**。首次使用在面板内 Settings → Models 配模型/API Key（与 pi CLI 共享 `~/.pi/agent/` 配置）。

**可选：独立运行**。装好的包也能脱离 IDE 在浏览器里跑（此时即原版 pi-web 形态，品牌位显示 Pi Web+）：

```bash
pi-web-for-ide            # http://127.0.0.1:3030；--port/--hostname/--no-open 等参数见 pi-web-for-ide --help
pi-web status|stop|open|update|update-sdk
```

## 设置项（扩展）

| 设置 | 说明 |
|---|---|
| `Pi for IDE.executablePath` | pi-web 入口绝对路径（standalone `server.js` 或 `bin/pi-web.js`）；一般留空自动解析。 |
| `Pi for IDE.workspaceRoot` | 传给会话的项目目录（`cwd`）；留空用当前工作区文件夹。 |
| `Pi for IDE.openBeside` | 面板打开在右侧相邻分栏（默认 true）。 |
| `Pi for IDE.port` | 起始端口（默认 3030，被占用自动 +1）。 |
| `Pi for IDE.package` | 托管/全局查询用的包名（默认 `@william_stone/pi-web-for-ide`）。 |

连不上服务器、面板空白、保存报错等排障指引：[vscode-extension-deploy.md](./vscode-extension-deploy.md)。

## 上游与各层贡献

- **[pi](https://github.com/earendil-works/pi)**（earendil-works）：底层智能体本体。
- **[pi-web](https://github.com/agegr/pi-web)**（agegr）：pi 的 Next.js Web UI——本仓的直接上游；Web 应用本体全部出自上游，我们定期合并上游版本而非重写。  
- **[pi-code](https://github.com/wangjinxin613/pi-code)**（wangjinxin613）：首个 IDE 集成——VSCode 扩展、embed 桥、文件审查/回退、活动文件注入均源于它；本仓库从它 fork。
- **[pi-for-ide](https://github.com/WilliamStone/Pi-for-IDE)（本仓）**：在 pi-code 之上——发行形态解耦（外置 npm 包 + 轻量扩展壳）、品牌分层（Pi Web+/Pi for IDE）、pnpm/PATH shim 解析、standalone MCP 修复、服务器/webview 生命周期修复、持续上游同步。详见 `docs/decoupling-plan.md`。

## 面向开发者

服务器入口解析顺序（扩展侧）：`Pi for IDE.executablePath` → 内置 `resources/`（过渡兼容）→ `npm root -g` → `pi-web-for-ide` PATH shim（只认本包专属命令名，上游 `pi-web` shim 不会被拉起）→ `globalStorage` 下版本化托管运行时（自动安装）。启动后探测 `GET /api/embed`，所连服务器不含 IDE 补丁时弹警告。

架构：

```
pi-for-ide 扩展（VSCode）
  ├── piIdeServer        解析入口 → spawn pi-web → 探测 /api/embed
  ├── webviewProvider    <iframe src="…/?embed=vscode"> + 就绪门
  └── bridge             页面 ↔ VSCode API：openFile / completeAt /
                         clipboard / 快照 / 回退 / activeEditor
@william_stone/pi-web-for-ide（外部包）
  └── embed 宿主抽象（?embed=<host>）——宿主无关协议，VSCode 是首个
      适配器，后续可接 JetBrains 等其他宿主
```

构建与同步：

```bash
npm install                 # 依赖
npm run build               # next build（浏览器应用）
node scripts/prepare-standalone.js   # npm pack 使用的 standalone 组装
npm pack                    # → @william_stone/pi-web-for-ide-<ver>.tgz
cd vscode-extension && npm run compile && npm run package   # → pi-for-ide-<ver>.vsix
bash scripts/sync-upstream.sh vX.Y.Z   # 合并上游 pi-web 某个 tag
```

日常开发时不要运行 `next build` 或 `npm run build`。它们会写入 `.next/`，可能干扰开发服务器；仅在发布流程中执行构建。

`PI_WEB_STANDALONE=1` 开启 Next standalone 输出；`scripts/` 下是上游同步与补丁导出工具链（`sync-upstream.sh`、`export-patches.sh`、`apply-to.sh`）。

开始做新功能之前，请先阅读[参与贡献](./CONTRIBUTING.zh-CN.md)，了解哪些改动在范围内以及提交 PR 前的检查项。

贡献者文档：[国际化](./i18n.md)和[发布流程](./release.md)。

## 仓库结构

```text
app/               Next.js 界面和 API 路由
components/        React 界面组件
hooks/             客户端状态和交互 hooks
lib/               会话、智能体、模型、文件、Git 和安全逻辑
public/            静态资源和 PWA 文件
bin/               npm CLI 入口及启动参数解析
vscode-extension/  pi-for-ide VSCode/VSCodium 扩展壳
docs/              面向用户和贡献者的专题文档
demo/              发布到 GitHub Pages 的静态演示站（见 demo/README.md）
```

架构说明和详细文件地图见 [AGENTS.md](../AGENTS.md)。

## 许可证

[MIT](../LICENSE)
