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

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { PiIdeServer } from "./piIdeServer";
import { sweepLegacyOrphans } from "./port-scan";
import { formatBuildStamp, installPiWebPackage, planUpgrade, type UpgradeAction } from "./server-resolve";
import { markUpgradeSurfaced, wasUpgradeSurfaced } from "./upgradeNotice";
import { outputChannel } from "./server-status";
import {
  installManagedLocalPackage,
  installManagedPackage,
  levelSupported,
  listManagedVersions,
  managedRuntimeRoot,
  setManagedMarker,
  sweepManagedVersions,
} from "./managedRuntime";
import { PiWebWebviewPanel } from "./webviewProvider";
import { registerSessionCommands, SessionsTreeProvider } from "./sessions-tree";
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

  // 会话面板注册表：tab 对应 session——点同一 session 复用其 tab，
  // 不同 session 各开各的。单面板模式（sessionTabs=single）时不开表。
  // 升级提示去重：同一动作（local build / registry 版本）本会话内只弹
  // 一次框——resolve 警告 / +8s 后台检查 / 手动命令共用标记
  // （upgradeNotice.ts），先触达的留下签名，后续只写报告不重复打扰。
  const upgradeSig = (a: UpgradeAction): string =>
    a.kind === "local"
      ? `local:${a.label}`
      : a.kind === "registry"
        ? `registry:${a.version}`
        : `none:${a.reason}`;

  const sessionPanels = new Map<string, PiWebWebviewPanel>();
  // 面板 → 注册表键的当前归属。new:<cwd> composer 面板落地成真会话后
  // 要改挂到 sessionId 键下，dispose 也要按当前键删（闭包里的旧键已失效）。
  const deletePanelKey = (panel: PiWebWebviewPanel) => {
    for (const [k, v] of sessionPanels) if (v === panel) sessionPanels.delete(k);
  };
  const sessionPanelFor = (id: string): PiWebWebviewPanel => {
    let p = sessionPanels.get(id);
    if (!p) {
      p = new PiWebWebviewPanel(
        context.extensionUri,
        () => server,
        () => ensureServer(),
        bridge,
        context.extension.packageJSON.version as string,
        () => deletePanelKey(p!),
        "chat",
        // composer 面板（new:<cwd> 键）在页面里真正建起会话 → 重挂到
        // 会话 id 键——之后点树上的该 session 复用这个 tab，不再开新的。
        (sessionId, title) => {
          if (sessionPanels.get(sessionId) === p) return;
          deletePanelKey(p!);
          if (!sessionPanels.has(sessionId)) sessionPanels.set(sessionId, p!);
          if (title) p!.setTitleOverride(`Pi — ${title.slice(0, 50)}`);
        },
      );
      sessionPanels.set(id, p);
      context.subscriptions.push(p);
    }
    return p;
  };
  // 会话 tab 的固定落点：任一已开会话面板所在组——首个面板 Beside 开列，
  // 后续全进同一组（tab 叠放），不随活动编辑器漂移。
  const sessionColumn = (): vscode.ViewColumn =>
    [...sessionPanels.values()].map((p) => p.currentViewColumn).find((c) => c !== undefined)
    ?? openViewColumn();
  let settingsPanel: PiWebWebviewPanel | undefined;
  const refreshAllPanels = async () => {
    await Promise.all(
      [provider, settingsPanel, ...sessionPanels.values()].map((p) => p?.refreshIfOpen()),
    );
  };

  // 影响 iframe URL 的配置改动对已开面板即改即生效——URL 变了 refresh
  // 就会重指 iframe（browserBtn 这类参数只在新加载时进入页面）。
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("Pi for IDE.showOpenInBrowser")) void refreshAllPanels();
    }),
  );

  // -------------------------------------------------------------------------
  // 共享实例标记 watch：任一窗口的宿主拉起新服务器（升级换包/重启）时写
  // <runtime>/server-instance.json——本宿主据此停掉过期引用并刷新已开面板。
  // 事件驱动、不轮询；外部重启（非扩展驱动）不写标记、维持原行为。
  // -------------------------------------------------------------------------
  {
    const runtimeDir = managedRuntimeRoot(context);
    fs.mkdirSync(runtimeDir, { recursive: true });
    let markerTimer: ReturnType<typeof setTimeout> | undefined;
    const onInstanceMarker = () => {
      clearTimeout(markerTimer);
      markerTimer = setTimeout(() => {
        void (async () => {
          let boot: string | undefined;
          try {
            boot = (JSON.parse(
              fs.readFileSync(path.join(runtimeDir, "server-instance.json"), "utf8"),
            ) as { boot?: string }).boot;
          } catch {
            return; // 文件半截/已删——等下一次事件
          }
          await PiIdeServer.invalidateIfBootMismatch(boot);
          await refreshAllPanels();
        })();
      }, 300);
    };
    try {
      const watcher = fs.watch(runtimeDir, (_ev, name) => {
        if (name === "server-instance.json") onInstanceMarker();
      });
      context.subscriptions.push({ dispose: () => watcher.close() });
    } catch (e) {
      outputChannel().appendLine(`instance marker watch failed (non-fatal): ${e}`);
    }
  }

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

  // -------------------------------------------------------------------------
  // 原生会话侧栏（Activity Bar → Sessions）：导航权归宿主，pi-web 侧栏由
  // TreeDataProvider 直连本地 API 替代；点开会话经 ?session= 深链导航面板。
  // -------------------------------------------------------------------------
  {
    // 服务 origin 的权威顺序：本窗口 ensureServer 的实例 → 共享实例标记
    // （别窗口/独立启动/扩展宿主重启后 server 变量为空，但服务其实活着）。
    const sessionsBaseUrl = async (): Promise<string | undefined> => {
      const s = server ? await server : undefined;
      if (s?.origin) return s.origin;
      try {
        const marker = JSON.parse(
          fs.readFileSync(path.join(managedRuntimeRoot(context), "server-instance.json"), "utf8"),
        ) as { origin?: string };
        return marker.origin;
      } catch {
        return undefined;
      }
    };
    const sessionsProvider = new SessionsTreeProvider(
      sessionsBaseUrl,
      context.workspaceState,
      () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    );
    const sessionsView = vscode.window.createTreeView("piIde.sessions", {
      treeDataProvider: sessionsProvider,
      showCollapseAll: true,
    });
    sessionsProvider.setVisible(sessionsView.visible);
    context.subscriptions.push(
      sessionsProvider,
      sessionsView,
      sessionsView.onDidChangeVisibility((e) => sessionsProvider.setVisible(e.visible)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => sessionsProvider.reload()),
    );
    void vscode.commands.executeCommand(
      "setContext", "piIde.sessions.workspaceOnly", sessionsProvider.isWorkspaceOnly(),
    );
    // 状态栏：待输入会话指示器——树藏起来时"有会话在等"不可见是真盲区；
    // awaiting 转移顺带 toast（可配关），点击聚焦会话视图/打开会话。
    const awaitBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    awaitBar.command = "workbench.view.extension.piIde";
    const notifiedAwaiting = new Set<string>();
    context.subscriptions.push(
      awaitBar,
      sessionsProvider.onDidChangeTreeData(() => {
        const awaiting = sessionsProvider.awaitingSessionIds;
        if (awaiting.size > 0) {
          const titles = [...awaiting]
            .map((id) => sessionsProvider.sessionById(id)?.name ?? id.slice(0, 8))
            .join("\n");
          awaitBar.text = `$(bell-dot) Pi: ${awaiting.size}`;
          awaitBar.tooltip = `${awaiting.size} session(s) awaiting input:\n${titles}`;
          awaitBar.show();
        } else {
          awaitBar.hide();
        }
        if (vscode.workspace.getConfiguration("Pi for IDE").get<boolean>("notifyAwaiting", true)) {
          for (const id of awaiting) {
            if (notifiedAwaiting.has(id)) continue;
            notifiedAwaiting.add(id);
            const title = sessionsProvider.sessionById(id)?.name ?? "A session";
            void vscode.window
              .showInformationMessage(`Pi: ${title} is awaiting input`, "View")
              .then((pick) => {
                if (pick === "View") void vscode.commands.executeCommand("piIde.session.open", id);
              });
          }
        }
        for (const id of [...notifiedAwaiting]) {
          if (!awaiting.has(id)) notifiedAwaiting.delete(id);
        }
      }),
    );

    // 设置页单例面板——?view=settings（加载即弹设置面板的精简壳）。
    settingsPanel = new PiWebWebviewPanel(
      context.extensionUri,
      () => server,
      () => ensureServer(),
      bridge,
      context.extension.packageJSON.version as string,
      undefined,
      "settings",
    );
    context.subscriptions.push(settingsPanel);
    settingsPanel.setTitleOverride("Pi — Settings");
    context.subscriptions.push(
      vscode.commands.registerCommand("piIde.settings", async (section?: string) => {
        const cwd = resolveConfiguredCwd()
          ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
          ?? "";
        void ensureServer();
        settingsPanel!.panelSection =
          typeof section === "string" && section ? section : undefined;
        await settingsPanel!.reveal(cwd, openViewColumn());
      }),
    );

    // 完整应用页入口（无 view=chat）——chat-only tab 精简掉的侧栏/设置/文件
    // 等功能，过渡期从这里够到。
    context.subscriptions.push(
      vscode.commands.registerCommand("piIde.openOriginal", async () => {
        const cwd = resolveConfiguredCwd()
          ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
          ?? "";
        void ensureServer();
        await provider!.reveal(cwd, openViewColumn());
      }),
    );

    registerSessionCommands(context, {
      getBaseUrl: sessionsBaseUrl,
      ensureServer,
      provider: sessionsProvider,
      // 会话在完整页面打开——chat 视图精简掉的设置/文件/技能等入口的
      // 过渡通道：主面板 + ?session= 深链，不带 view=chat。
      openSessionFull: async (id: string) => {
        const cwd = sessionsProvider.sessionById(id)?.cwd
          ?? resolveConfiguredCwd()
          ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
          ?? "";
        void ensureServer();
        await provider!.reveal(cwd, openViewColumn(), id);
      },
      openSession: async (id: string, title?: string) => {
        // 面板 cwd 用会话自己的目录——跨项目点开不受当前配置 cwd 影响。
        const cwd = sessionsProvider.sessionById(id)?.cwd
          ?? resolveConfiguredCwd()
          ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
          ?? "";
        const perSession = vscode.workspace
          .getConfiguration("Pi for IDE")
          .get<string>("sessionTabs", "perSession") === "perSession";
        if (!perSession) {
          void ensureServer();
          await provider!.reveal(cwd, openViewColumn(), id);
          return;
        }
        const panel = sessionPanelFor(id);
        void ensureServer();
        await panel.reveal(cwd, sessionColumn(), id);
        if (title) panel.setTitleOverride(`Pi — ${title}`);
      },
      openProject: async (cwd: string, label?: string) => {
        // 项目新建会话也是会话上下文面板——同一 chatMode、tab 对应项目，
        // cwd 参数把 composer 钉在项目目录。
        const key = `new:${cwd}`;
        const panel = sessionPanelFor(key);
        void ensureServer();
        await panel.reveal(cwd, sessionColumn());
        panel.setTitleOverride(`Pi — ${label ?? "New session"}`);
      },
    });
  }

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

  // ---- 升级执行共享件：命令与后台通知共用 ----

  /** 装完后的收尾提示：有运行中服务器问重启；没有也要给一句交代（静默成功像死按钮）。 */
  const restartPrompt = async (label: string): Promise<void> => {
    const running = await server;
    if (running && !running.disposed) {
      const r = await vscode.window.showInformationMessage(
        `${label} Restart the server to apply.`,
        "Restart Server",
        "Later",
      );
      if (r === "Restart Server") {
        await running.stop();
        await ensureServer();
        // 实例已换——已打开的面板重指到新 origin（refresh 内部判断
        // 实例变化才重推 URL，shell 探测后就绪了再换 iframe）。
        await refreshAllPanels();
      }
      // 其他窗口的面板经实例标记自动刷新（需那边也跑新版扩展）；
      // 浏览器里打开的 tab 扩展够不着——提示用户手动 reload。
      void vscode.window.showInformationMessage(
        "Pi for IDE server updated. Panels in other windows switch over on their own; reload any browser tabs open to the old server (F5) to pick up the new build.",
      );
      return;
    }
    void vscode.window.showInformationMessage(`${label} Takes effect on next server start.`);
  };

  /**
   * 按升级计划动作执行安装 + 收尾。命令的 Install/Upgrade 与后台通知
   * 的 Install 共用同一路径——后台那一下点击就是直接装，不弹第二层确认。
   */
  const applyUpgradeAction = async (
    a: Exclude<UpgradeAction, { kind: "none" }>,
    pkg: string,
    localTgz: string,
  ): Promise<void> => {
    const ch = outputChannel();
    if (a.kind === "local") {
      const ok = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Installing ${pkg} from local tarball…` },
        (progress) =>
          installManagedLocalPackage(ch, context, localTgz, (m) =>
            progress.report({ message: m }),
          ),
      );
      if (!ok) {
        void vscode.window.showErrorMessage(`${pkg} local install failed — see the Pi for IDE output panel for details.`);
        return;
      }
      await restartPrompt(`${pkg} installed from local tarball (${a.label}).`);
      return;
    }
    // a.kind === "registry"
    const ok = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Upgrading ${pkg}…` },
      (progress) =>
        a.managed
          ? installManagedPackage(ch, context, pkg, a.version, (msg) =>
              progress.report({ message: msg }),
            )
          : installPiWebPackage(ch, pkg, a.version),
    );
    if (!ok) {
      void vscode.window.showErrorMessage(
        `${pkg} upgrade failed — see the Pi for IDE output panel for details.`,
      );
      return;
    }
    await restartPrompt(`${pkg} upgraded to ${a.version}.`);
  };

  // 升级命令：采集各侧候选 → 报告对照（来源设置/各侧版本/当前版本）→
  // 结论 → 确认 → 安装 → 重启本窗口服务器。托管运行时走版本目录
  // （不碰运行中的旧目录）；全局安装走包管理器原地升级。
  context.subscriptions.push(
    vscode.commands.registerCommand("piIde.upgrade", async () => {
      const cfg = vscode.workspace.getConfiguration("Pi for IDE");
      const pkg = (cfg.get<string>("package") ?? "").trim() || "@william_stone/pi-web-for-ide";
      // 安装来源选择（Pi for IDE.installSource）：
      //   auto          = 两边比，同版本→本地；localPackage 没填只有在线候选；
      //   prefer-remote = 两边比，同版本→在线；
      //   local / registry = 单边锁死。
      const installSource = (cfg.get<string>("installSource") ?? "auto").trim();
      const localTgz = (cfg.get<string>("localPackage") ?? "").trim();
      if (installSource === "local" && !localTgz) {
        void vscode.window.showErrorMessage("Pi for IDE: installSource is local but localPackage is not set.");
        return;
      }
      const fmtBuild = formatBuildStamp;

      // 升级计划（planUpgrade）：采集→对照报告→flow→动作——与后台检查
      // 共用同一判定；这里只负责渲染与执行。
      const plan = await planUpgrade(context, pkg, installSource, localTgz);

      // 完整对照写输出通道；浮窗单行结论 + Details… 开通道看全表。
      const ch = outputChannel();
      ch.appendLine(`\n=== upgrade check — installSource: ${installSource} ===`);
      for (const l of plan.report) ch.appendLine(`  ${l}`);
      const DETAILS = "Details…";
      const showDetails = (pick?: string) => {
        // show() 不带 preserveFocus——Details 的意图就是"给我看"，面板
        // 要抢焦点出现；show(true) 只把通道开在不抢焦点的位置，用户看不到。
        if (pick === DETAILS) ch.show();
        return pick === DETAILS;
      };
      const curLabel = plan.current ? `${plan.current.version}${fmtBuild(plan.current.builtAt)}` : "none";

      const a = plan.action;
      if (a.kind !== "none") markUpgradeSurfaced(upgradeSig(a));
      if (a.kind === "none") {
        // 本地侧有具体失败原因时优先呈现——"already at latest" 只描述
        // registry 半边的结论，本地包缺失/被拒的真相被埋在 Details 里
        // 会误导（曾踩：tgz 消失→提示已最新，实际是本地侧空）。
        const localReason = plan.local?.reason;
        const msg = `${pkg}: ${localReason ? `local: ${localReason}; ` : ""}${a.reason}.`;
        showDetails(
          await (a.reason.startsWith("already at") && !localReason
            ? vscode.window.showInformationMessage(msg, DETAILS)
            : a.reason.includes("requires a newer") || a.reason.includes("refused") || localReason
              ? vscode.window.showWarningMessage(msg, DETAILS)
              : vscode.window.showErrorMessage(msg, DETAILS)),
        );
        return;
      }
      if (a.kind === "local") {
        const pick = await vscode.window.showInformationMessage(
          `Local build ${a.label} is ${a.recommended ? "newer" : "not newer"} than current ${curLabel}.`,
          a.recommended ? "Install" : "Install Anyway",
          DETAILS,
          "Cancel",
        );
        if (showDetails(pick)) return;
        if (!pick?.startsWith("Install")) return;
        await applyUpgradeAction(a, pkg, localTgz);
        return;
      }

      // a.kind === "registry"
      const pick = await vscode.window.showInformationMessage(
        `${pkg} ${a.version} is available (current: ${curLabel}).${a.managed ? " Instances in other windows are unaffected and switch on restart." : ""}`,
        "Upgrade Now",
        DETAILS,
        "Later",
      );
      if (showDetails(pick)) return;
      if (pick !== "Upgrade Now") return;
      await applyUpgradeAction(a, pkg, localTgz);
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
          `${v.builtAt ? ` ·${formatBuildStamp(v.builtAt)}` : ""}` +
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
      // 安装来源语义与 piIde.upgrade 完全一致——同一个 planUpgrade：
      // 后台检查只是"有计划可装时发个通知"，判定逻辑零重复。
      const cfgUpd = vscode.workspace.getConfiguration("Pi for IDE");
      const installSource = (cfgUpd.get<string>("installSource") ?? "auto").trim();
      const localTgz = (cfgUpd.get<string>("localPackage") ?? "").trim();
      if (installSource === "local" && !localTgz) return;
      const plan = await planUpgrade(context, pkg, installSource, localTgz);
      const fmt = formatBuildStamp;
      const cur = plan.current ? `${plan.current.version}${fmt(plan.current.builtAt)}` : "none";
      const a = plan.action;
      // 与命令一致的通道报告——Details 按钮开的表就在这里。
      const ch = outputChannel();
      ch.appendLine(`\n=== upgrade check (auto) — installSource: ${installSource} ===`);
      for (const l of plan.report) ch.appendLine(`  ${l}`);
      // 同一动作刚由 resolve 警告/手动命令提示过 → 只留报告不再弹框。
      const sig = upgradeSig(a);
      if (a.kind !== "none" && wasUpgradeSurfaced(sig)) {
        ch.appendLine("  (same upgrade already prompted this session — notification skipped)");
        return;
      }
      if (a.kind !== "none") markUpgradeSurfaced(sig);
      const DETAILS = "Details…";
      const showDetails = (pick?: string) => {
        if (pick === DETAILS) ch.show();
        return pick === DETAILS;
      };
      if (a.kind === "local" && a.recommended) {
        const pick = await vscode.window.showInformationMessage(
          `Local build ${a.label} is newer than current ${cur}.`,
          "Install",
          DETAILS,
          "Later",
        );
        if (showDetails(pick)) return;
        // Install 就是直接装——后台通知本身就是确认，不再弹命令的第二层。
        if (pick === "Install") await applyUpgradeAction(a, pkg, localTgz);
      } else if (a.kind === "registry") {
        const pick = await vscode.window.showInformationMessage(
          `${pkg} ${a.version} is available (current: ${cur}).`,
          "Upgrade Now",
          DETAILS,
          "Later",
        );
        if (showDetails(pick)) return;
        if (pick === "Upgrade Now") await applyUpgradeAction(a, pkg, localTgz);
      } else if (a.kind === "none" && a.reason.includes("requires a newer")) {
        // 包太新需要升级扩展——这值得单独提醒。
        void vscode.window.showInformationMessage(`${pkg}: ${a.reason}.`);
      }
      // 其余 none / 未推荐的本地构建 → 静默（手动跑升级命令能看到完整对照）。
    })();
  }, 8000);
}

export function deactivate(): void {
  void server?.then((s) => s?.release());
}
