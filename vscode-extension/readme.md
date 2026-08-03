# Pi Web — VSCode 扩展

![Pi Web 截图](screen.png)

把 [Pi Web](https://github.com/agegr/pi-web)（pi 编程智能体的 Next.js Web UI）以 VSCode 扩展形式提供。

- 保留：会话浏览、聊天、模型 / 技能 / 插件配置、i18n、SSE、主题、分支导航。
- 去除：内置文件浏览器（FileExplorer 文件树、FileViewer 右侧预览面板、TabBar、worktree 切换器、`@` 文件索引）。这些功能改由 VSCode 原生资源管理器 / 编辑器承接。
- 桥接：页面内"打开文件"与"`@` 文件补全"通过 `lib/vscode-bridge.ts` 与扩展宿通信，落到 VSCode API 上。

## 架构

```
扩展宿 (extension.ts)
  ├── PiWebServer            以子进程启动 pi-web（`pi-web -p 0 --no-open`）并解析其打印的 URL
  ├── PiWebWebviewPanel     注册 webview 面板，渲染一个 <iframe> 指向 pi-web 服务器
  └── Bridge                 处理页面 → VSCode 的请求：openFile / completeAt / readFile / notify
```

消息路径：

```
pi-web 页面 (iframe)
  ── window.parent.postMessage({ source: "pi-web", id, request }) ──▶ webview HTML
  ── vscode.postMessage(...) ──▶ 扩展宿
  ◀── webview.postMessage({ source: "vscode", id, payload }) ── 扩展宿
  ◀── iframe.contentWindow.postMessage(...) ── webview HTML
  ◀── window 'message' 监听 ── pi-web 页面 (lib/vscode-bridge.ts)
```

## 开发与构建

```bash
cd vscode-extension
npm install
npm run compile      # tsc -p .   → out/
npm run watch        # 监听模式
```

打包 `.vsix`：

```bash
npx @vscode/vsce package
```

## 运行

1. `npm run build`（pi-web 仓库根目录）以产出 `.next/`。
2. 确保全局可用 `pi-web`：`npm i -g @agegr/pi-web`，或在用户设置里配置 `piWeb.executablePath`。
3. 在 VSCode 扩展宿里 F5 启动调试，命令面板运行 **Pi Web: 打开 Pi Web**，或点击右下角状态栏的 Pi Web 图标。

## 限制

- 扩展按需启动 pi-web 子进程；如果本机没装 `pi-web`，会在输出面板提示。
- `?vscode=1` 让 pi-web 隐藏文件浏览器相关 UI，但**不破坏**其在普通浏览器里的独立运行能力。
- `@` 文件补全回退到 VSCode 的 `findFiles`，结果上限 50 条。
