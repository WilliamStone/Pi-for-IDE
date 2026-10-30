# 参与贡献 Pi for IDE / Pi Web+

[English](../CONTRIBUTING.md)

本仓库产出两个可独立安装的产物：**`pi-for-ide` 扩展**（轻量 VS Code/VSCodium 宿主）和 **`@william_stone/pi-web-for-ide`**（"Pi Web+"，pi-web Web 应用加宿主适配层，也可脱离 IDE 在浏览器独立运行）。产品目标：让 pi 智能体用起来像编辑器自带的功能——原生会话树、会话与设置开在编辑器标签页、原生 diff 与回退——同时 Web 应用本身保持独立可用。

## 本项目要做什么

- **IDE 集成层**。一切让 pi 属于编辑器的部分：Pi Sessions 树、perSession/composer/设置标签、`@` 提及与活动文件上下文、原生 diff 与轮次回退、嵌入生命周期、多窗口行为。
- **宿主中性的嵌入协议**。`?embed=<host>` 的能力协商、消息与生命周期在 `lib/embed/` 与扩展桥里。VS Code 是首个适配器；抽象必须保持宿主无关，JetBrains 类宿主日后才能接入。
- **pi-web 本体，保持上游兼容**。Web 应用 fork 自 `agegr/pi-web` 并持续合并上游；对它的改进在不加深 fork 差异的前提下欢迎。

## 范围外

- **改变 pi 本体行为的改动**——system prompt、工具行为、prompt 模板、重试、压缩、会话文件格式。这些属于上游 pi 项目。
- **仅 pi-web 可表达的扩展 API**。pi CLI 扩展无法表达的新 `ctx.ui.*` 选项或 `extension_ui_request` 字段：为 pi CLI 写的扩展必须在这里行为一致，pi 的 TUI 是扩展请求语义的参照。
- **宿主特异性泄漏进公共底座**。`app/`/`lib/` 中 `lib/embed/` 之外不得出现 VS Code 假设——嵌入特性归属适配层，并在 standalone 模式下优雅降级。
- **对上游文件的大改重写**。pi-web 文件里的每一处就地修改都是未来的合并冲突；上游侧改动压到最小调用点（见 `AGENTS.md` 的 fork 差异纪律）。

## 约定

- **差异纪律**：嵌入/IDE 特性优先落在自有文件（`lib/embed/**`、`components/embed/**`、`vscode-extension/**`、`bin/pi-web-standalone.js`）；必须动上游文件时，优先加调用点而非改签名。
- **用户可见字符串**：扩展清单字符串走 `package.nls.json`（en 默认 + zh-CN）；其余各处运行时字符串只写英文。Web 应用自身的 i18n 见 `docs/i18n.md`。
- **提交前检查**：`node_modules/.bin/tsc --noEmit`、`npm run lint`、`npm test`；扩展侧在 `vscode-extension/` 里跑 `tsc --noEmit`、`npx eslint src`、`npm test`。开发期不要运行 `next build`（见 `AGENTS.md`）。
- **领域笔记**：`AGENTS.md` 把各代码区域映射到 `docs/agents/` 下的笔记——改动前读对应笔记，设计结论也回记到那里。

## 提交 PR

- 一个 PR 只做一件事；不相关的修复分开提。
- 修 bug 要给出在 `main` 上的复现步骤，并说明修复针对的是因不是症。
- 新功能先开 issue 讲用例——涉及嵌入协议或会话视图的尤其如此。
- 避免新增运行时依赖；确有必要请说明理由。
