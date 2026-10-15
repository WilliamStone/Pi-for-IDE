# pi-code — Pi Web+ / pi for IDE

[English](./README.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

[pi 编程智能体](https://github.com/badlogic/pi-mono) 的 Web 界面，同时能以一等面板形态嵌入 VSCode/VSCodium。本仓库产出两个可独立安装、独立更新的产物：

| 产物 | 名称 | 角色 |
|---|---|---|
| npm 包 | **`pi-web-for-ide`** | 增强版 pi-web。独立浏览器运行时品牌为 **Pi Web+**；被宿主以 `?embed=<host>` 嵌入时切换为 **pi for IDE** 宿主模式。CLI 命令：`pi-web`。 |
| VSCode 扩展 | **`pi-for-ide`**（`WilliamStone.pi-for-ide`） | 轻量宿主壳（~190KB），拉起或连接全局安装的发行包，在 webview 内叠加 IDE 集成能力。 |

扩展不再捆绑 pi-web——两者解耦发行。

## 功能

### pi-web 本体（独立运行与嵌入模式均可用）

- 会话管理：浏览、搜索、分叉、恢复本机 pi 会话，实时流式对话
- 模型与服务商配置：OAuth 登录、API Key、models.json 编辑、模型目录刷新
- MCP 服务器配置、技能搜索/安装、插件启用/禁用
- 文件预览、worktree、终端面板、i18n（en/zh-CN/ja/ru）、明暗主题、PWA
- `pi-web` CLI：`pi-web [--port N] [--hostname H] [--no-open]`、`status`、`stop`、`open`、`update`、`update-sdk`

### IDE 集成（embed 模式，VSCode 宿主）

- **`@` 文件提及**：补全走 `vscode.workspace.findFiles`，不再查服务器文件系统
- **右键提及**：资源管理器/编辑器右键「在 pi for IDE 中提及」文件与选中代码
- **活动文件上下文注入**：正在查看的文件以隐藏 marker 注入 system prompt（AI 可见、UI 不显示、不落盘）
- **文件审查卡片 + inline diff + 一键回退**：每轮列出 AI 改动的文件；回退恢复代码并删除该轮会话记录——只读 git，绝不产生 stash/commit
- **剪贴板桥接**：沙箱 iframe 里的复制/粘贴走 `vscode.env.clipboard`
- 内置文件树/预览面板在宿主模式下隐藏，交还 VSCode 资源管理器与编辑器组

所有 IDE 相关能力都挂在 `?embed=<host>` 开关后——普通浏览器访问就是完整的 pi-web，宿主桥不激活。

## 安装与使用

要求 Node.js ≥ 22.19.0。

### 独立运行（Pi Web+）

```bash
npm install -g pi-web-for-ide   # 或本地包：npm i -g ./pi-web-for-ide-0.12.1.tgz
pi-web                          # 监听 http://127.0.0.1:3030，自动开浏览器
```

`PI_WEB_PASSWORD='足够长的随机密码' pi-web` 启用 HTTP Basic Auth（用户名固定 `pi`）。包依赖 postinstall 把 Turbopack 外部包接成 junction——请确保装包脚本允许执行（pnpm 默认执行；npm 见 `docs/vscode-extension-deploy.md` 排障节）。

### VSCode / VSCodium（pi for IDE）

1. 按上文全局安装 `pi-web-for-ide`。
2. 装扩展：`code --install-extension vscode-extension/pi-for-ide-0.1.0.vsix`（VSCodium 用 `codium`）。
3. 点状态栏 **pi for IDE** 按钮，或命令面板执行 **pi for IDE: 打开**。

扩展按序解析服务器入口：`piIde.executablePath` → 内置 `resources/`（过渡兼容）→ `npm root -g` → `pi-web` PATH shim（支持 pnpm/yarn/bun shim）→ `npx` 兜底。启动后探测 `GET /api/embed`，若所连服务器不含 IDE 补丁会弹警告。

| 设置 | 说明 |
|---|---|
| `piIde.executablePath` | pi-web 入口绝对路径（standalone `server.js` 或 `bin/pi-web.js`）。 |
| `piIde.package` | 全局查询与 npx 兜底使用的包名（默认 `pi-web-for-ide`）。 |
| `piIde.workspaceRoot` | 传给 pi-web 会话的项目目录（`cwd`）；留空用当前工作区文件夹。 |
| `piIde.openBeside` | 面板打开在右侧相邻分栏（默认 true）。 |
| `piIde.port` | 起始端口（默认 3030，被占用自动 +1）。 |

完整部署与排障指南见 [`docs/vscode-extension-deploy.md`](./docs/vscode-extension-deploy.md)。

## 架构

```
pi-for-ide 扩展（VSCode）
  ├── piIdeServer        解析入口 → spawn pi-web → 探测 /api/embed
  ├── webviewProvider    <iframe src="…/?embed=vscode"> + 就绪门
  └── bridge             页面 ↔ VSCode API：
                         openFile / completeAt / clipboard / 快照 /
                         回退 / activeEditor
pi-web-for-ide（外部包）
  └── embed 宿主抽象（?embed=<host>）——宿主无关协议，VSCode 是首个
      适配器，后续可接 JetBrains 等其他宿主
```

## 上游与各层贡献

- **[pi](https://github.com/badlogic/pi-mono)**（badlogic）：底层编程智能体本体——所有层共同驱动的引擎。
- **[pi-web](https://github.com/agegr/pi-web)**（agegr）：pi 的 Next.js Web UI——本仓的直接上游。整个 Web 应用（会话 UI、流式对话、模型/MCP/技能/插件管理、终端、PWA）出自上游；我们定期合并上游版本而不是重写。
- **[pi-code](https://github.com/wangjinxin613/pi-code)**（wangjinxin613）：首个 IDE 集成——引入了 VSCode 扩展、embed 宿主模式（`?embed`）、页面↔宿主桥、文件审查/回退、活动文件注入。本仓库从它 fork。
- **本仓（WilliamStone/pi-code）**：在 pi-code 之上——发行形态解耦（外置 `pi-web-for-ide` npm 包 + 轻量扩展壳）、品牌分层（Pi Web+/pi for IDE）、pnpm/PATH shim 服务器解析、standalone MCP 修复、服务器/webview 生命周期修复，以及持续的上游同步。详见 `docs/decoupling-plan.md`。

## 开发

```bash
npm install                 # 依赖
npm run build               # next build（浏览器应用）
node scripts/prepare-standalone.js   # npm pack 使用的 standalone 组装
npm pack                    # → pi-web-for-ide-<ver>.tgz
cd vscode-extension && npm run compile && npm run package   # → pi-for-ide-<ver>.vsix
bash scripts/sync-upstream.sh vX.Y.Z   # 合并上游 pi-web 某个 tag
```

`PI_WEB_STANDALONE=1` 开启 Next standalone 输出；`scripts/` 下是上游同步与补丁导出工具链（`sync-upstream.sh`、`export-patches.sh`、`apply-to.sh`）。
