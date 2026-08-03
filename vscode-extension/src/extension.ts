/**
 * Pi Web VSCode 扩展 — 主入口。
 *
 * Pi Web 是 pi 编程智能体的独立 Next.js Web 界面。本扩展将这一 Web 界面托管
 * 在 webview 内，并在后台启动一个本地 pi-web 服务器。除了文件浏览器之外，
 * 其余体验与原版一致：会话浏览、聊天、模型/技能/插件配置、i18n 均照常工作；
 * 打开文件、@ 补全等动作通过桥接转交给 VSCode 原生 API。
 *
 * 生命周期：
 *  - activate：预热 pi-web 服务器、注册视图/命令。
 *  - piWeb.start / piWeb.open：按需启动服务器，并在当前分栏或右侧（Beside）展示面板。
 *  - piWeb.stop：终止服务器。
 *  - webview.onDidReceiveMessage：把 openFile / completeAt / readFile / notify
 *    请求从页面转交回 VSCode API，并返回结果。
 *  - dispose：停止服务器并销毁 webview。
 */

import * as vscode from "vscode";
import { PiWebServer } from "./piWebServer";
import { PiWebWebviewPanel } from "./webviewProvider";
import { Bridge } from "./bridge";

let server: Promise<PiWebServer | undefined>;
let provider: PiWebWebviewPanel | undefined;
let bridge: Bridge;
let bridgeChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  bridgeChannel = vscode.window.createOutputChannel("Pi Web 桥接");
  context.subscriptions.push(bridgeChannel);
  bridge = new Bridge((line) => bridgeChannel.appendLine(line));

  // 状态栏图标 — 常驻可见，一键唤起聊天面板。
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.text = "$(comment-discussion) Pi Web";
  statusBarItem.tooltip = "Pi Web — 点击打开聊天面板";
  statusBarItem.command = "piWeb.open";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // 保持「服务器运行中」上下文键同步，以便显示「停止」按钮。
  const setRunningContext = (running: boolean) => {
    vscode.commands.executeCommand("setContext", "piWeb.serverRunning", running);
  };
  setRunningContext(false);

  // 懒启动服务器 — 仅在用户显式请求时启动。避免为只装了扩展但还没用的人
  // 白白 spawn 一个 Next.js 进程。
  const ensureServer = (): Promise<PiWebServer | undefined> => {
    server = PiWebServer.ensureStarted(context).then((s) => {
      setRunningContext(!!s);
      if (s) {
        statusBarItem.text = "$(comment-discussion) Pi Web";
        statusBarItem.backgroundColor = undefined;
        statusBarItem.tooltip = `Pi Web — 运行中，地址 ${s.origin}`;
      }
      return s;
    }).catch((error) => {
      console.error("[pi-web] 启动服务器失败:", error);
      setRunningContext(false);
      return undefined;
    });
    return server;
  };

  provider = new PiWebWebviewPanel(
    context.extensionUri,
    () => server,
    () => ensureServer(),
    bridge,
  );

  context.subscriptions.push(provider);

  // -------------------------------------------------------------------------
  // 命令
  // -------------------------------------------------------------------------

  context.subscriptions.push(
    vscode.commands.registerCommand("piWeb.start", async () => {
      const s = await ensureServer();
      if (s) {
        vscode.window.showInformationMessage(`Pi Web 服务器已启动，地址 ${s.origin}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("piWeb.stop", async () => {
      const s = await server;
      if (s) {
        await s.stop();
        setRunningContext(false);
        vscode.window.showInformationMessage("Pi Web 服务器已停止。");
      }
    }),
  );

  // 主入口 — 在状态栏和命令面板中可见。按需启动服务器，并在右侧
  // （Beside）展示面板。
  context.subscriptions.push(
    vscode.commands.registerCommand("piWeb.open", async () => {
      const config = vscode.workspace.getConfiguration("piWeb");
      const openBeside = config.get<boolean>("openBeside", true);
      const viewColumn = openBeside
        ? vscode.ViewColumn.Beside
        : vscode.ViewColumn.Active;

      // 解析 cwd：显式设置 > 工作区文件夹 > 弹窗选择。
      let cwd = config.get<string>("workspaceRoot", "").trim();
      if (!cwd) {
        cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
      }
      if (!cwd) {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          title: "Pi Web：选择项目目录",
        });
        if (!picked || picked.length === 0) return;
        cwd = picked[0].fsPath;
      }

      await ensureServer();
      await provider!.reveal(cwd, viewColumn);
    }),
  );

  // `piWeb.reveal` 仅聚焦已存在的面板（不触碰服务器）。
  context.subscriptions.push(
    vscode.commands.registerCommand("piWeb.reveal", () => {
      provider!.focus();
    }),
  );

  // ---------------------------------------------------------------------------
  // 右键菜单：在 pi-web 聊天输入框中提及文件 / 选中的代码段
  // ---------------------------------------------------------------------------

  /**
   * 从资源管理器/编辑器的上下文里解析出「相对于工作区的相对路径」。
   * 支持多根工作区；不属任何工作区时返回 undefined。
   */
  function relativePathFor(uri: vscode.Uri): string | undefined {
    const ws = vscode.workspace.getWorkspaceFolder(uri);
    if (!ws) return undefined;
    return vscode.workspace.asRelativePath(uri, false);
  }

  /**
   * 触发一次提及：确保服务器和面板就绪，再把 payload 推给页面。
   * 面板未打开时会先按 piWeb.open 的同样流程打开一次。
   */
  async function triggerMention(payload: {
    relativePath: string;
    startLine?: number;
    endLine?: number;
    selectedText?: string;
  }): Promise<void> {
    // 面板可能还没打开；先确保服务器就绪，再 reveal（用当前 cwd）。
    const config = vscode.workspace.getConfiguration("piWeb");
    const openBeside = config.get<boolean>("openBeside", true);
    const viewColumn = openBeside
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.Active;
    let cwd = config.get<string>("workspaceRoot", "").trim();
    if (!cwd) cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    if (!cwd) return; // 没有 cwd 时 pi-web 没法挂载会话，直接退出。

    await ensureServer();
    await provider!.reveal(cwd, viewColumn);
    await provider!.pushMention(payload);
  }

  // 资源管理器 / 编辑器标题栏右键单个文件 -> 提及文件
  context.subscriptions.push(
    vscode.commands.registerCommand("piWeb.mentionFile", async (uri: vscode.Uri) => {
      const relativePath = relativePathFor(uri);
      if (!relativePath) {
        vscode.window.showWarningMessage("Pi Web：无法获取该文件相对工作区的路径。");
        return;
      }
      await triggerMention({ relativePath });
    }),
  );

  // 编辑器里选中文本后右键 -> 提及代码段
  context.subscriptions.push(
    vscode.commands.registerCommand("piWeb.mentionSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const uri = editor.document.uri;
      const relativePath = relativePathFor(uri);
      if (!relativePath) {
        vscode.window.showWarningMessage("Pi Web：无法获取该文件相对工作区的路径。");
        return;
      }
      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);
      // 空选择时退化为整文件提及。
      if (selection.isEmpty) {
        await triggerMention({ relativePath });
        return;
      }
      // 行号 1-based，闭区间。
      const startLine = selection.start.line + 1;
      const endLine = selection.end.line + 1;
      // 末行如果选中到行首，实际不含该行，退化为上一行。
      const adjustedEnd =
        selection.end.character === 0 && endLine > startLine
          ? endLine - 1
          : endLine;
      await triggerMention({
        relativePath,
        startLine,
        endLine: adjustedEnd,
        selectedText: selectedText || undefined,
      });
    }),
  );
}

export function deactivate(): void {
  void server?.then((s) => s?.stop());
}
