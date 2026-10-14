# pi for IDE VSCode 扩展 — 安装与初始化部署

> 面向手工测试的操作清单。架构背景见 `decoupling-plan.md`。
> 本文步骤在当前仓库 `S:\DevSpace\AI\Agents\pi-code` 已验证（Windows 11）。

## 前提

| 项 | 要求 |
|---|---|
| Node.js | ≥ 22.19.0（`node --version` 检查；pi-web CLI 会自检并拒绝旧版） |
| npm | 随 Node 自带 |
| VSCode | ≥ 1.85（webview iframe + clipboard API） |

## 一、安装外部 pi-web-for-ide（必需）

扩展自身不再内置 pi-web 服务器，首次使用前必须把发行包装到本机。三种方式**任选其一**，按推荐度排序：

### 方式 A（推荐）：全局安装本地 tarball

```bash
# 在仓库根目录：构建 + 打包（prepack 自动产出 standalone 自包含树，约 2-3 分钟）
npm pack                    # → pi-web-for-ide-0.12.1.tgz（约 46MB）

npm i -g ./pi-web-for-ide-0.12.1.tgz
```

验证：

```bash
pi-web --version            # 0.12.1
pi-web --port 30146 --no-open
# 另开终端：
curl http://127.0.0.1:30146/api/embed   # → {"embed":{"protocol":1}}
pi-web stop                              # 停掉测试服务器
```

`/api/embed` 返回 `{"embed":{"protocol":1}}` 是**打过 IDE 集成补丁的 pi-web 的指纹**——原版上游包没有此端点。扩展启动后也会探测它，连到原版（或未打补丁的包名）会弹警告而不是静默失败。

> npm 可能提示 `allow-scripts` 警告（postinstall / node-pty 等）。这些是
> 终端功能与遥测的 install 脚本，被拦不影响 embed/会话等核心功能；
> 需要内置终端面板时执行 `npm approve-scripts pi-web-for-ide` 再重装。

### 方式 B：直接指定入口路径

不装包，指到仓库构建产物或解压目录：

- 设置 `piIde.executablePath` = `<pkg>/.next/standalone/server.js`
  （`PI_WEB_STANDALONE=1 npm run build` 产出的 standalone server）
- 或 = `<pkg>/bin/pi-web.js`（任何含补丁的 pi-web 发行/仓库入口）

### 方式 C：npx 兜底（需已发布到 npm 后才有意义）

什么都不装时扩展会尝试 `npx -y pi-web-for-ide`——当前包未发布，**本地测试阶段不可用**，忽略。

## 二、构建并安装扩展

```bash
cd vscode-extension
npm install          # 首次
npm run compile      # tsc -p . → out/
npm run package      # → pi-for-ide-0.1.0.vsix（约 189KB）
```

安装（命令面板 → `Extensions: Install from VSIX…`，或）：

```powershell
code --install-extension .\pi-for-ide-0.1.0.vsix
```

## 三、设置项（全部有默认值，零配置可用）

设置 → 搜 `piWeb`：

| 设置 | 默认 | 何时需要改 |
|---|---|---|
| `piIde.package` | `pi-web-for-ide` | 发行包改名时 |
| `piIde.executablePath` | 空（自动解析） | 不用全局安装、想指向仓库构建产物时 |
| `piIde.workspaceRoot` | 空（当前工作区） | 想让会话跑在别的目录时 |
| `piIde.port` | `3030` | 端口冲突时（占用了会自动 +1） |
| `piIde.openBeside` | `true` | 想开在当前栏时设 false |

服务器解析顺序：`executablePath` → 内置 `resources/pi-web`（本版已摘除）→ `npm root -g`/`PATH` 的全局包 → `npx` 兜底。解析失败会列出依次尝试过什么。

## 四、首次启动与初始化

1. VSCode 打开目标项目工作区。
2. 命令面板 → **pi for IDE: 打开 pi for IDE**（或编辑器标题栏的 pi for IDE 图标）。
3. 扩展按上述顺序拉起 pi-web 子进程，打印 `pi-web ready: http://127.0.0.1:3030`，然后探测 `/api/embed` 通过后渲染 iframe。
4. **模型/API Key**：pi-web 的设置面板内完成（OAuth 登录或 API Key 管理），数据落在 `~/.pi/agent/models.json`——与 pi CLI 共享同一份配置；也可用环境变量（如 `ANTHROPIC_API_KEY`）。
5. **工作目录**：新会话的 cwd 取 `piIde.workspaceRoot` ?? 当前工作区根目录。

## 五、功能验证清单（实测点）

| 验证项 | 操作 | 预期 |
|---|---|---|
| embed 桥 | 打开面板 | 无文件树/文件面板 UI（宿主接管）；顶部有「在浏览器中打开」按钮 |
| `/api/embed` | `curl http://127.0.0.1:<port>/api/embed` | `{"embed":{"protocol":1}}` |
| @ 补全 | 输入框打 `@` | 候选来自 VSCode `workspace.findFiles`（≤50 条，含行号） |
| 右键提及 | 编辑器/资源管理器右键 → 在 pi for IDE 中提及 | 输入框注入 `@文件` 或带行号引用 |
| 活动文件注入 | VSCode 里打开某文件后发消息 | 输入框下方提示「当前打开：xxx」；AI 优先改该文件 |
| 剪贴板 | 复制消息文本 / 粘贴进输入框 | 跨源 iframe 下正常（走 `vscode.env.clipboard`） |
| 文件审查 | 让 AI 改文件 | 该轮末尾出现审查卡片，inline diff 可展开 |
| 一键回退 | hover 用户消息左侧回退按钮 → 确认 | 代码恢复 + 该轮会话删除，列表自动刷新 |

## 六、排障

- **面板报「未找到 pi-web 服务器」**：按第四节解析顺序排查——`npm root -g` 下是否有 `pi-web-for-ide`；`pi-web --version` 在 VSCode 同一环境是否能跑（PATH 差异时用 `executablePath` 兜底）。
- **启动后警告「未包含 embed 桥补丁」**：连到原版 pi-web——检查 `piIde.package` 名是否仍是 `pi-web-for-ide`，或全局装的是旧 tarball（重新 `npm pack` + `npm i -g`）。
- **端口被占**：`piIde.port` 会自动 +1 探测；也可 `pi-web status` 查看现有服务 / `pi-web stop` 停掉。
- **更新 SDK**：`pi-web update-sdk <version>`（服务须先停）；`pi-web update` 升级 pi-web-for-ide 本体。
- **保存模型设置报 `EPERM rename …\.models.json-*.tmp -> models.json`**（Windows）：
  不是代码 bug，是该文件对象上挂了内核态残留引用（曾有不释放 delete-share
  的进程抓过它，常见于崩溃/被杀的 pi 系进程或安全软件）。判别特征：
  能直接写、能改名、能 `del`，唯独 `rename(tmp→models.json)` 拒绝。
  解法：备份后删了重建——
  `copy models.json %TEMP%\models.json && del models.json && copy %TEMP%\models.json models.json`，
  文件对象换新后原子写恢复。
- **看日志**：输出面板 → 扩展的 pi for IDE 通道记录了 spawn 命令、端口与探测结果。
