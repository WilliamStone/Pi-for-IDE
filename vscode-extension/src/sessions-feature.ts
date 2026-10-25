// 原生会话侧栏（Activity Bar → Pi Sessions）：导航权归宿主，pi-web 侧栏由
// TreeDataProvider 直连本地 API 替代；点开会话经 ?session= 深链导航面板。
// 同区块还挂：状态栏待输入指示器、设置页单例面板、Open Original Page、
// 以及会话命令注册（registerSessionCommands 的宿主接线）。

import * as vscode from "vscode";
import { Bridge } from "./bridge";
import { piConfig } from "./config";
import { readInstanceMarker } from "./instance-coordination";
import { managedRuntimeRoot } from "./managedRuntime";
import { currentServerStatus } from "./server-status";
import { PiIdeServer } from "./piIdeServer";
import { SessionPanels } from "./session-panels";
import { registerSessionCommands, SessionsTreeProvider } from "./sessions-tree";
import { PiWebWebviewPanel } from "./webviewProvider";

export interface SessionsFeatureDeps {
  /** 本窗口当前服务器 promise（可为空）。 */
  server: () => Promise<PiIdeServer | undefined> | undefined;
  ensureServer: () => Promise<PiIdeServer | undefined>;
  /** 完整应用面板（?session= 深链但不带 view=chat 的通道也走它）。 */
  provider: PiWebWebviewPanel;
  bridge: Bridge;
  /** 会话面板注册表（perSession 模式的落点）。 */
  sessionPanels: SessionPanels;
  /** 会话 cwd 兜底解析：workspaceRoot 配置 > 首个工作区文件夹。 */
  resolveConfiguredCwd: () => string;
  /** openBeside 语义的出口列。 */
  openViewColumn: () => vscode.ViewColumn;
}

export interface SessionsFeature {
  /** 设置页单例面板（refreshAllPanels 成员）。 */
  settingsPanel: PiWebWebviewPanel;
}

export function registerSessionsFeature(
  context: vscode.ExtensionContext,
  deps: SessionsFeatureDeps,
): SessionsFeature {
  const { server, ensureServer, provider, sessionPanels, resolveConfiguredCwd, openViewColumn } = deps;

  // 服务 origin 的权威顺序：本窗口 ensureServer 的实例 → 共享实例标记
  // （别窗口/独立启动/扩展宿主重启后 server 变量为空，但服务其实活着）。
  const sessionsBaseUrl = async (): Promise<string | undefined> => {
    const s = server() ? await server() : undefined;
    if (s?.origin) return s.origin;
    return readInstanceMarker(managedRuntimeRoot(context))?.origin;
  };

  const sessionsProvider = new SessionsTreeProvider(
    sessionsBaseUrl,
    context.workspaceState,
    () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    () => PiIdeServer.starting(),
    () => currentServerStatus(),
  );
  const sessionsView = vscode.window.createTreeView("piIde.sessions", {
    treeDataProvider: sessionsProvider,
    showCollapseAll: true,
  });
  // 打开侧栏=使用意图——立即可见的 "Server is starting…" 胜过等用户
  // 再点某个命令才开始解析/spawn。ensureStarted 是幂等单例，重复踢零成本。
  sessionsProvider.setVisible(sessionsView.visible);
  if (sessionsView.visible) void ensureServer();
  context.subscriptions.push(
    sessionsProvider,
    sessionsView,
    sessionsView.onDidChangeVisibility((e) => {
      sessionsProvider.setVisible(e.visible);
      if (e.visible) void ensureServer();
    }),
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
      if (piConfig().get<boolean>("notifyAwaiting", true)) {
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
  const settingsPanel = new PiWebWebviewPanel(
    context.extensionUri,
    () => server() ?? Promise.resolve(undefined),
    () => ensureServer(),
    deps.bridge,
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
      settingsPanel.panelSection =
        typeof section === "string" && section ? section : undefined;
      await settingsPanel.reveal(cwd, openViewColumn());
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
      await provider.reveal(cwd, openViewColumn());
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
      await provider.reveal(cwd, openViewColumn(), id);
    },
    openSession: async (id: string, title?: string) => {
      // 面板 cwd 用会话自己的目录——跨项目点开不受当前配置 cwd 影响。
      const cwd = sessionsProvider.sessionById(id)?.cwd
        ?? resolveConfiguredCwd()
        ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        ?? "";
      const perSession = piConfig().get<string>("sessionTabs", "perSession") === "perSession";
      if (!perSession) {
        void ensureServer();
        await provider.reveal(cwd, openViewColumn(), id);
        return;
      }
      const panel = sessionPanels.forKey(id);
      void ensureServer();
      await panel.reveal(cwd, sessionPanels.column(), id);
      if (title) panel.setTitleOverride(`Pi — ${title}`);
    },
    openProject: async (cwd: string, label?: string) => {
      // 项目新建会话也是会话上下文面板——同一 chat 形态、tab 对应项目，
      // cwd 参数把 composer 钉在项目目录。
      const key = `new:${cwd}`;
      const panel = sessionPanels.forKey(key);
      void ensureServer();
      await panel.reveal(cwd, sessionPanels.column());
      panel.setTitleOverride(`Pi — ${label ?? "New session"}`);
    },
  });

  return { settingsPanel };
}
