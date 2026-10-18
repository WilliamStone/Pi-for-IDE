/**
 * Pi for IDE VSCode 扩展 — 主入口。
 *
 * Pi for IDE 将 pi-web（pi 编程智能体的 Web 界面，本仓库发行 @william_stone/pi-web-for-ide）托管
 * 在 webview 内，并在后台启动一个本地 pi-web 服务器。除了文件浏览器之外，
 * 其余体验与原版一致：会话浏览、聊天、模型/技能/插件配置、i18n 均照常工作；
 * 打开文件、@ 补全等动作通过桥接转交给 VSCode 原生 API。
 *
 * 生命周期：
 *  - activate：预热 pi-web 服务器、注册视图/命令。
 *  - piIde.start / piIde.open：按需启动服务器，并在当前分栏或右侧（Beside）展示面板。
 *  - piIde.stop：终止服务器。
 *  - webview.onDidReceiveMessage：把 openFile / completeAt / readFile / notify
 *    请求从页面转交回 VSCode API，并返回结果。
 *  - dispose：停止服务器并销毁 webview。
 */

import * as vscode from "vscode";
import { PiIdeServer } from "./piIdeServer";
import { sweepLegacyOrphans } from "./port-scan";
import { checkPiWebUpdate, installPiWebPackage } from "./server-resolve";
import { outputChannel } from "./server-status";
import {
  installManagedPackage,
  isNewerVersion,
  levelSupported,
  listManagedVersions,
  setManagedMarker,
  sweepManagedVersions,
} from "./managedRuntime";
import { PiWebWebviewPanel } from "./webviewProvider";
import { Bridge, clearActiveEditorCache, resolveActiveEditor } from "./bridge";

let server: Promise<PiIdeServer | undefined>;
let provider: PiWebWebviewPanel | undefined;
let bridge: Bridge;
let bridgeChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // 统一输出频道：桥接/生命周期/spawn 日志同流（按时间戳排序）。
  bridgeChannel = outputChannel();
  context.subscriptions.push(bridgeChannel);
  bridge = new Bridge((line) => bridgeChannel.appendLine(line));

  // 存量清理（过渡措施，后续版本移除）：历史版本 npx 启动的 server.js
  // 孤儿会攥住 _npx 缓存目录致后续 npx EBUSY——托管运行时落地后这些
  // 残留进程只剩害处，激活时静默清一遍。
  void sweepLegacyOrphans(bridgeChannel);

  // 状态栏图标 — 常驻可见，一键唤起聊天面板。
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.text = "$(comment-discussion) Pi for IDE";
  statusBarItem.tooltip = "Pi for IDE — click to open the chat panel";
  statusBarItem.command = "piIde.open";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // 保持「服务器运行中」上下文键同步，以便显示「停止」按钮。
  const setRunningContext = (running: boolean) => {
    vscode.commands.executeCommand("setContext", "piIde.serverRunning", running);
  };
  setRunningContext(false);

  // 懒启动服务器 — 仅在用户显式请求时启动。避免为只装了扩展但还没用的人
  // 白白 spawn 一个 Next.js 进程。
  const ensureServer = (): Promise<PiIdeServer | undefined> => {
    server = PiIdeServer.ensureStarted(context).then((s) => {
      setRunningContext(!!s);
      if (s) {
        statusBarItem.text = "$(comment-discussion) Pi for IDE";
        statusBarItem.backgroundColor = undefined;
        statusBarItem.tooltip = `Pi for IDE — running at ${s.origin}`;
      }
      return s;
    }).catch((error) => {
      outputChannel().appendLine(`[pi-web] server start failed: ${error}`);
      setRunningContext(false);
      return undefined;
    });
    return server;
  };

  // 可选预热："Pi for IDE.autoStart" 开着就在激活时后台拉起服务器，
  // 首次点面板不用等启动；默认关——用不到的用户不为常驻进程买单。
  if (vscode.workspace.getConfiguration("Pi for IDE").get<boolean>("autoStart")) {
    void ensureServer();
  }

  provider = new PiWebWebviewPanel(
    context.extensionUri,
    () => server,
    () => ensureServer(),
    bridge,
    context.extension.packageJSON.version as string,
  );

  context.subscriptions.push(provider);

  // -------------------------------------------------------------------------
  // 命令
  // -------------------------------------------------------------------------

  context.subscriptions.push(
    vscode.commands.registerCommand("piIde.start", async () => {
      const s = await ensureServer();
      if (s) {
        vscode.window.showInformationMessage(`Pi for IDE server started at ${s.origin}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("piIde.stop", async () => {
      const s = await server;
      if (s) {
        await s.stop();
        setRunningContext(false);
        vscode.window.showInformationMessage("Pi for IDE server stopped.");
      }
    }),
  );

  // 主入口 — 在状态栏和命令面板中可见。按需启动服务器，并在右侧
  /** 会话 cwd/栏位共享解析：workspaceRoot 配置 > 首个工作区文件夹。 */
  const resolveConfiguredCwd = (): string => {
    const config = vscode.workspace.getConfiguration("Pi for IDE");
    return (
      config.get<string>("workspaceRoot", "").trim() ||
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
      ""
    );
  };
  const openViewColumn = (): vscode.ViewColumn =>
    vscode.workspace.getConfiguration("Pi for IDE").get<boolean>("openBeside", true)
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.Active;

  // （Beside）展示面板。
  context.subscriptions.push(
    vscode.commands.registerCommand("piIde.open", async () => {
      const viewColumn = openViewColumn();

      // 解析 cwd：显式设置 > 工作区文件夹 > 弹窗选择。
      let cwd = resolveConfiguredCwd();
      if (!cwd) {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          title: "Pi for IDE: Select project directory",
        });
        if (!picked || picked.length === 0) return;
        cwd = picked[0].fsPath;
      }

      // 先踢启动再 reveal——reveal 内部 refresh 会等共享的 server promise，
      // 面板立刻出现「正在启动」页而不是等服务起好才现身（首击无反应的来源）。
      void ensureServer();
      await provider!.reveal(cwd, viewColumn);
    }),
  );

  // `piIde.reveal` 仅聚焦已存在的面板（不触碰服务器）。
  context.subscriptions.push(
    vscode.commands.registerCommand("piIde.reveal", () => {
      provider!.focus();
    }),
  );

  // 在系统默认浏览器中打开 Pi for IDE（面板工具条按钮 / 命令面板 / 面板标题栏）。
  context.subscriptions.push(
    vscode.commands.registerCommand("piIde.openInBrowser", async () => {
      const s = await server;
      if (s?.resolvedOrigin) {
        await vscode.env.openExternal(vscode.Uri.parse(s.resolvedOrigin));
      } else {
        vscode.window.showWarningMessage("Pi for IDE server is not running; cannot open in browser.");
      }
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
   * 面板未打开时会先按 piIde.open 的同样流程打开一次。
   */
  async function triggerMention(payload: {
    relativePath: string;
    startLine?: number;
    endLine?: number;
    selectedText?: string;
  }): Promise<void> {
    // 面板可能还没打开；先确保服务器就绪，再 reveal（用当前 cwd）。
    const viewColumn = openViewColumn();
    const cwd = resolveConfiguredCwd();
    if (!cwd) return; // 没有 cwd 时 pi-web 没法挂载会话，直接退出。

    void ensureServer();
    await provider!.reveal(cwd, viewColumn);
    await provider!.pushMention(payload);
  }

  // 资源管理器 / 编辑器标题栏右键单个文件 -> 提及文件
  context.subscriptions.push(
    vscode.commands.registerCommand("piIde.mentionFile", async (uri: vscode.Uri) => {
      const relativePath = relativePathFor(uri);
      if (!relativePath) {
        vscode.window.showWarningMessage("Pi for IDE: cannot resolve this file's workspace-relative path.");
        return;
      }
      await triggerMention({ relativePath });
    }),
  );

  // 编辑器里选中文本后右键 -> 提及代码段
  context.subscriptions.push(
    vscode.commands.registerCommand("piIde.mentionSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const uri = editor.document.uri;
      const relativePath = relativePathFor(uri);
      if (!relativePath) {
        vscode.window.showWarningMessage("Pi for IDE: cannot resolve this file's workspace-relative path.");
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

  // -------------------------------------------------------------------------
  // 当前活动编辑器文件 → 推送给 pi-web（用于隐藏 system prompt 上下文 + 输入框提示）
  // -------------------------------------------------------------------------

  /** 把当前活动编辑器文件推给 pi-web（面板未打开时为空操作，等面板刷新时同步）。 */
  const pushActiveEditor = (): void => {
    const active = resolveActiveEditor();
    provider?.pushActiveEditor({
      relativePath: active?.relativePath ?? null,
      filePath: active?.filePath ?? null,
    });
  };

  // 活动编辑器切换 / 编辑器打开关闭时同步
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(pushActiveEditor),
  );
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(() => {
      // 刚打开的文件若成为活动编辑器也会触发 onDidChangeActiveTextEditor；
      // 这里兜底，覆盖「非活动列打开文件」的场景。
      setTimeout(pushActiveEditor, 0);
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme !== "file") return;
      clearActiveEditorCache(doc.uri.fsPath);
      // 关闭后立即重新推送（可能因缓存失效变为 null，或回退到别的文件）。
      setTimeout(pushActiveEditor, 0);
    }),
  );

  // 升级命令：检查→确认→安装→重启本窗口服务器。托管运行时走版本目录
  // （不碰运行中的旧目录）；全局安装走包管理器原地升级。
  context.subscriptions.push(
    vscode.commands.registerCommand("piIde.upgrade", async () => {
      const pkg =
        (vscode.workspace.getConfiguration("Pi for IDE").get<string>("package") ?? "").trim() ||
        "@william_stone/pi-web-for-ide";
      const info = await checkPiWebUpdate(pkg, context);
      if (!info) {
        void vscode.window.showInformationMessage("Pi for IDE: no installed pi-web package found.");
        return;
      }
      if (info.needsExtensionUpgrade) {
        void vscode.window.showWarningMessage(
          `pi-web ${info.latest} (level ${info.latestLevel}) requires a newer Pi for IDE extension. Please upgrade the extension from the marketplace first.`,
        );
        return;
      }
      if (!info.best || !isNewerVersion(info.best, info.current)) {
        void vscode.window.showInformationMessage(`pi-web is already at the latest compatible version (${info.current}).`);
        return;
      }
      const pick = await vscode.window.showInformationMessage(
        `pi-web ${info.best} is available (current: ${info.current}).${info.managed ? " Instances in other windows are unaffected and switch on restart." : ""}`,
        "Upgrade Now",
        "Later",
      );
      if (pick !== "Upgrade Now") return;
      const installChannel = outputChannel();
      const ok = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Upgrading ${pkg}…` },
        (progress) =>
          info.managed
            ? installManagedPackage(installChannel, context, pkg, info.best, (msg) =>
                progress.report({ message: msg }),
              )
            : installPiWebPackage(installChannel, pkg, info.best),
      );
      if (!ok) {
        void vscode.window.showErrorMessage(
          `${pkg} upgrade failed — see the Pi for IDE output panel for details.`,
        );
        return;
      }
      // 运行中的服务器仍是旧代码，提示重启生效。
      const running = await server;
      if (running && !running.disposed) {
        const r = await vscode.window.showInformationMessage(
          `${pkg} upgraded to ${info.best}. Restart the server to apply.`,
          "Restart Server",
          "Later",
        );
        if (r === "Restart Server") {
          await running.stop();
          await ensureServer();
        }
      }
    }),
  );

  // 管理服务器版本（兜底）：列出已装托管版本（级别/兼容性标注），
  // 支持切换 marker（含降级）与清理非当前版本。
  context.subscriptions.push(
    vscode.commands.registerCommand("piIde.versions", async () => {
      const pkg =
        (vscode.workspace.getConfiguration("Pi for IDE").get<string>("package") ?? "").trim() ||
        "@william_stone/pi-web-for-ide";
      const versions = listManagedVersions(context, pkg);
      type Item = vscode.QuickPickItem & { action: "switch" | "cleanup"; version?: string };
      const items: Item[] = versions.map((v) => ({
        label: `${v.current ? "$(star-full) " : ""}${v.version}`,
        description:
          `level ${v.level ?? "unknown"}${levelSupported(v.level) ? "" : " (unsupported by this extension)"}` +
          `${v.ready ? "" : " (bin missing)"}${v.current ? " · current" : ""}`,
        detail: v.dir,
        action: "switch",
        version: v.version,
      }));
      items.push({ label: "$(trash) Clean up non-current versions", action: "cleanup" });
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: "Managed server versions — switching takes effect after restart (cleanup only removes versions below the current one)",
      });
      if (!pick) return;
      if (pick.action === "cleanup") {
        await sweepManagedVersions(context, outputChannel());
        void vscode.window.showInformationMessage("Pi for IDE: old versions cleaned up (directories in use were skipped).");
        return;
      }
      if (!pick.version) return;
      setManagedMarker(context, pick.version);
      const r = await vscode.window.showInformationMessage(
        `Switched to ${pick.version}. Restart the server to apply.`,
        "Restart Server",
        "Later",
      );
      if (r === "Restart Server") {
        const running = await server;
        await running?.stop();
        await ensureServer();
      }
    }),
  );

  // -------------------------------------------------------------------------
  // pi-web 发行包升级检查（后台、一次、静默失败）
  // -------------------------------------------------------------------------
  // 通知只告知有新版本；按钮统一走 piIde.upgrade 命令（同一条编排路径）。
  if (!vscode.workspace.getConfiguration("Pi for IDE").get<boolean>("checkForUpdates", true)) {
    return;
  }
  setTimeout(() => {
    void (async () => {
      const pkg =
        (vscode.workspace.getConfiguration("Pi for IDE").get<string>("package") ?? "").trim() ||
        "@william_stone/pi-web-for-ide";
      const info = await checkPiWebUpdate(pkg, context);
      if (!info) return;
      if (info.needsExtensionUpgrade) {
        void vscode.window.showInformationMessage(
          `pi-web ${info.latest} requires a newer Pi for IDE extension — please upgrade the extension from the marketplace first.`,
        );
        return;
      }
      if (!info.best || !isNewerVersion(info.best, info.current)) return;
      const pick = await vscode.window.showInformationMessage(
        `pi-web ${info.best} is available (current: ${info.current}).`,
        "Upgrade Now",
        "Later",
      );
      if (pick === "Upgrade Now") void vscode.commands.executeCommand("piIde.upgrade");
    })();
  }, 8000);
}

export function deactivate(): void {
  void server?.then((s) => s?.release());
}
