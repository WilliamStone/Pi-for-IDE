# Pi for IDE — VS Code 扩展

![Pi for IDE 截图](screen.png)

[**Pi for IDE**](https://github.com/WilliamStone/Pi-for-IDE) 把完整的 [pi-web](https://github.com/agegr/pi-web) 界面装进 VS Code 面板——与 pi 编程智能体对话、浏览会话历史、配置模型与技能——外加一组编辑器原生集成：真 diff、文件@提及、一键回退。

Web 应用本身仍是独立产品：同一个服务也可以在浏览器里跑，扩展与 Web 应用各自独立升级。

## 你能得到什么

### 完整的 pi web 界面，就在IDE里

点IDE状态栏右下角的 **Pi for IDE 按钮**（或运行 `Pi for IDE: Open`）——面板在你的代码旁边打开：会话浏览、流式输出、工具调用展示、分支导航、主题、多语言界面，一应俱全。

- **开箱即用**：首次使用扩展可以自己下载并管理服务器组件——打开面板就行。喜欢用命令行？`pnpm add -g @william_stone/pi-web-for-ide`。装好后 `pi-web-for-ide` 命令在 PATH 上，扩展会自动用它。
- **一个服务，大家共享**：已有兼容服务在跑（另一个窗口、或你自己启动的）时，面板直接连上它而不是再开一份——会话与数据单一视图。连到已存在的实例时会提示你连的是哪个。
- **问题诊断**：如果连上的服务给不了 IDE 集成能力（装错包、版本太旧、装了一半），你会看到具体的警告和该执行的修复命令——绝不是一个静默的白屏。
- **随时可达**：面板的「**在浏览器中打开**」按钮把同一个服务开进系统浏览器。

### 贴合你的工作区

- **`@` 提及**：输入框敲 `@` 直接挑工作区文件——走 VS Code 自己的文件搜索。
- **右键提及**：编辑器和资源管理器右键菜单有「Mention This File / Mention This Code」。
- **剪贴板桥接**：面板内的复制粘贴和编辑器其他部分一样。
- **活动文件感知**：当前打开的文件会悄悄放进智能体的视野——输入框下方有提示，你始终知道 AI 手里是哪个文件。

### 审查与撤销智能体的改动

每轮结束后，「**File review**」卡片列出这轮动过的文件：

- **Open diff in editor**——VS Code 原生双侧 diff，看本轮改了什么。
- **Open file in editor**——直接跳到那个文件。
- **回退此轮**——hover 用户消息点 *Revert*：该轮动过的每个文件回到改动前的状态，该轮的对话记录同时移除。回退中间某一轮不会弄丢后面的内容。操作前确认。

### 自己会收拾

- **用完即走**：扩展拉起的服务在最后一个窗口或页面断开后不久自行退出——不会留一个进程过夜。
- **开关在手**：`Pi for IDE: Start Server` / `Stop Server` 随叫随到；`Pi for IDE.autoStart` 也能让服务随编辑器启动。
- **升级不翻车**：服务在跑时升级包会提前告诉你"先停再装"，而不是装到一半留一个坏掉的安装。

## 命令

| 命令 | 作用 |
|---|---|
| `Pi for IDE: Open` | 打开 Pi for IDE 面板 |
| `Pi for IDE: Show Panel` | 显示已创建的面板 |
| `Pi for IDE: Start Server` | 启动本地服务 |
| `Pi for IDE: Stop Server` | 停止本窗口管理的服务 |
| `Pi for IDE: Open in Browser` | 在系统浏览器里打开同一界面 |
| `Pi for IDE: Mention This File` | 在输入框提及当前文件 |
| `Pi for IDE: Mention This Code` | 提及选中的代码 |
| `Pi for IDE: Upgrade Server Component` | 升级服务组件 |
| `Pi for IDE: Manage Server Versions` | 选择用哪个已安装版本 |

## 设置项

| 设置 | 作用 |
|---|---|
| `Pi for IDE.autoStart` | 编辑器启动时拉起服务（默认关）。 |
| `Pi for IDE.autoStop` | 扩展拉起的服务在所有连接断开后自退（默认开）。 |
| `Pi for IDE.autoStopAfterSec` | 静默多久后自退，下限 90 秒（默认 `90`）。 |
| `Pi for IDE.port` | 首选端口（默认 `3030`，被占自动顺延）。 |
| `Pi for IDE.workspaceRoot` | 智能体在哪个目录工作。留空 → 当前工作区。 |
| `Pi for IDE.openBeside` | 面板开在代码旁边的相邻分栏（默认开）；关闭则开在当前活动分栏。 |
| `Pi for IDE.executablePath` | 指定某个服务构建。留空 → 自动。 |
| `Pi for IDE.package` | 由哪个包提供服务（默认 `@william_stone/pi-web-for-ide`）。 |
| `Pi for IDE.checkForUpdates` | 有新服务包时通知你（默认开）。 |

## 说明

- 可像原版 pi-web 一样独立运行并在浏览器中使用——同一个包两种用法。
- 想要一个绝不共享的专属服务，把 `Pi for IDE.port` 配到 3030–3039 之外。
- 回退把该轮改动过的文件恢复到轮前状态；你在轮后手动改过的文件会被跳过并给出提示，不会被覆盖。
