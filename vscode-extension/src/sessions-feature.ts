// 原生会话侧栏（Activity Bar → Pi Sessions）：导航权归宿主，pi-web 侧栏由
// TreeDataProvider 直连本地 API 替代；点开会话经 ?session= 深链导航面板。
// 同区块还挂：状态栏待输入指示器、设置页单例面板、Open Original Page、
// 以及会话命令注册（registerSessionCommands 的宿主接线）。

import * as vscode from "vscode";
import { promises as fsp } from "fs";
import * as path from "path";
import { Bridge } from "./bridge";
import { piConfig } from "./config";
import { readInstanceMarker } from "./instance-coordination";
import { managedRuntimeRoot } from "./managedRuntime";
import { currentServerStatus, onServerStatus, outputChannel } from "./server-status";
import { watchPendingOpens } from "./pending-open";
import {
  OrphanRegistry,
  registerOrphanPanelRevival,
  type OrphanTab,
} from "./panel-revival";
import { PiIdeServer } from "./piIdeServer";
import { openProjectSettings } from "./project-settings";
import { SessionPanels } from "./session-panels";
import { sessionTitle } from "./sessions-model";
import { META_ROW_SCHEME, registerSessionCommands, SessionsTreeProvider } from "./sessions-tree";
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

  // 服务 origin 的权威顺序：已握手实例 resolvedOrigin → 绑口即在途握手
  // 的 boundOrigin（/api/sessions 是独立轻路由，不等 embed 握手——抢先
  // 列出让冷启清单提前 ~2.5s）→ 共享实例标记（别窗口/宿主重启后仍活着）。
  // 不 await ensureServer：那会把清单钉死在握手之后。
  const sessionsBaseUrl = async (): Promise<string | undefined> => {
    const inst = PiIdeServer.peek();
    const o = inst ? (inst.resolvedOrigin ?? inst.boundOrigin) : undefined;
    return o ?? readInstanceMarker(managedRuntimeRoot(context))?.origin;
  };

  const sessionsProvider = new SessionsTreeProvider(
    sessionsBaseUrl,
    context.workspaceState,
    () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    () => PiIdeServer.starting(),
    () => currentServerStatus(),
  );
  // 双行 meta 副行的透明占位图标——让 meta 文本与会话标题文字同列。
  sessionsProvider.metaIconUri = vscode.Uri.joinPath(
    context.extensionUri, "resources", "icons", "blank.svg",
  );
  // meta 副行 label 走私有 resourceUri——这里把它染成 description 暗色，
  // 副行视觉降一级又不破坏与标题文字的列对齐。
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider({
      provideFileDecoration: (uri) =>
        uri.scheme === META_ROW_SCHEME
          ? { color: new vscode.ThemeColor("descriptionForeground"), propagate: false }
          : undefined,
    }),
  );
  const sessionsView = vscode.window.createTreeView("piIde.sessions", {
    treeDataProvider: sessionsProvider,
    // 内置 collapse-all 是单向按钮——双态折叠/展开改由自绘命令对
    // （piIde.sessions.collapseAll/expandAll + allCollapsed context）承载。
    showCollapseAll: false,
  });
  // 打开侧栏=使用意图——立即可见的 "Server is starting…" 胜过等用户
  // 再点某个命令才开始解析/spawn。ensureStarted 是幂等单例，重复踢零成本。
  sessionsProvider.setVisible(sessionsView.visible);
  // 阶段推进（绑口/握手等广播）即时补一拍——boundOrigin 落地那拍就能
  // 出清单，不欠 2.5s 轮询节拍的账。
  context.subscriptions.push({
    dispose: onServerStatus(() => sessionsProvider.kick()),
  });
  // 跨窗 attach 场景本窗收不到任何状态广播——注册即试暖一拍
  // （无 base 时 getBaseUrl 返空，零成本）。
  sessionsProvider.kick();
  if (sessionsView.visible) void ensureServer();
  context.subscriptions.push(
    sessionsProvider,
    sessionsView,
    sessionsView.onDidChangeVisibility((e) => {
      sessionsProvider.setVisible(e.visible);
      if (e.visible) void ensureServer();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => sessionsProvider.reload()),
    // 手动展开/折叠同样改按钮态：把组键记账交给 provider，事件只上报。
    sessionsView.onDidExpandElement((e) => {
      const g = (e.element as { group?: { key: string } }).group;
      if (!g) return;
      sessionsProvider.noteExpanded(g.key);
      void vscode.commands.executeCommand(
        "setContext", "piIde.sessions.allCollapsed", sessionsProvider.isAllCollapsed(),
      );
    }),
    sessionsView.onDidCollapseElement((e) => {
      const g = (e.element as { group?: { key: string } }).group;
      if (!g) return;
      sessionsProvider.noteCollapsed(g.key);
      void vscode.commands.executeCommand(
        "setContext", "piIde.sessions.allCollapsed", sessionsProvider.isAllCollapsed(),
      );
    }),
  );
  void vscode.commands.executeCommand(
    "setContext", "piIde.sessions.workspaceOnly", sessionsProvider.isWorkspaceOnly(),
  );
  // 双态按钮对的显隐键：metaLayout 读配置作初值；viewMode/allCollapsed 取 provider 态。
  void vscode.commands.executeCommand(
    "setContext", "piIde.sessions.metaLayout",
    piConfig().get<string>("sessions.metaLayout", "line"),
  );
  void vscode.commands.executeCommand(
    "setContext", "piIde.sessions.viewMode", sessionsProvider.viewMode,
  );
  void vscode.commands.executeCommand(
    "setContext", "piIde.sessions.allCollapsed", sessionsProvider.isAllCollapsed(),
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

  // 孤儿占位登记处（panel-revival 枚举填入）——deserialize 按 tab 懒
  // 触发，没被点开的孤儿永远是占位符：点它 → adopt 原地收养；reveal/
  // openSession 命中 → 这里关占位+原位重开做交换（API 不给激活任意
  // tab，交换是最接近"激活"的等价物，且杜绝与死占位并存的重影）。
  const orphans = new OrphanRegistry();
  const closeOrphan = async (orphan: OrphanTab): Promise<void> => {
    try {
      await vscode.window.tabGroups.close(orphan.tab);
    } catch {
      /* 已不在——照常重开 */
    }
  };
  // 交换列：孤儿当前组优先（live 读——用户可能拖过组），枚举快照兜底。
  const orphanColumn = (o: OrphanTab | undefined): vscode.ViewColumn | undefined =>
    o ? (o.tab.group?.viewColumn ?? o.viewColumn) : undefined;
  // 死 tab 标题回会话名：setTitleOverride 产出 "Pi — <name>"，剥前缀
  // 还原；其他形态（如 "Pi for IDE — <cwd>" 兜底标题）不当作会话名用。
  const titleFromOrphanLabel = (label: string | undefined): string | undefined =>
    label?.startsWith("Pi — ") ? label.slice("Pi — ".length) : undefined;

  // 设置页单例面板——?view=settings（加载即弹设置面板的精简壳）。
  const settingsPanel = new PiWebWebviewPanel(
    context.extensionUri,
    () => server() ?? Promise.resolve(undefined),
    () => ensureServer(),
    deps.bridge,
    context.extension.packageJSON.version as string,
    undefined,
    "settings",
    undefined,
    "piIde.webview.settings",
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
      const orphan = orphans.takeKind("settings");
      if (orphan) await closeOrphan(orphan);
      await settingsPanel.reveal(cwd, orphanColumn(orphan) ?? openViewColumn());
    }),
  );

  // `<dir>/.pi/settings.json` 直达编辑器：视图菜单→配置 cwd；项目组
  // 右键→group.root。文件不存在→绑定路径的 untitled，保存才落盘。
  // 注意：view/title 菜单命令会收到树当前选中项作参数（实测）——同一
  // 命令两个入口共用会跟随"最后点过的项目节点"。视图入口必须完全
  // 忽略参数只解析配置 cwd；项目节点走专用命令读 item.group.root。
  const openSettingsAt = async (
    dir: string | undefined,
    via: string,
    argDesc: string,
  ) => {
    outputChannel().appendLine(
      `[settings] editProjectSettings(${via}): ${argDesc} dir=${dir ?? "?"}`,
    );
    if (!dir) {
      void vscode.window.showWarningMessage(
        "No project directory to open .pi/settings.json for.",
      );
      return;
    }
    await openProjectSettings(dir);
  };
  const argDesc = (item: vscode.TreeItem | undefined) =>
    item === undefined ? "item=none" : `item=cv=${String(item.contextValue)}`;
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "piIde.sessions.editProjectSettings",
      async (item?: vscode.TreeItem) => {
        await openSettingsAt(
          resolveConfiguredCwd() ??
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          "view",
          argDesc(item),
        );
      },
    ),
    vscode.commands.registerCommand(
      "piIde.sessions.editProjectSettingsHere",
      async (item?: vscode.TreeItem) => {
        await openSettingsAt(
          (item as { group?: { root?: string } } | undefined)?.group?.root,
          "item",
          argDesc(item),
        );
      },
    ),
  );

  // 完整应用页入口（无 view=chat）——chat-only tab 精简掉的侧栏/设置/文件
  // 等功能，过渡期从这里够到。
  context.subscriptions.push(
    vscode.commands.registerCommand("piIde.openOriginal", async () => {
      const cwd = resolveConfiguredCwd()
        ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        ?? "";
      void ensureServer();
      const orphan = orphans.takeKind("main");
      if (orphan) await closeOrphan(orphan);
      await provider.reveal(cwd, orphanColumn(orphan) ?? openViewColumn());
    }),
  );

  const newSessionAt = async (cwd: string, label?: string) => {
    // 新建会话也是会话上下文面板——同一 chat 形态，cwd 钉住 composer
    // 的工作目录；key=new:<cwd> 复用已有 composer tab。
    // cwd 先过 realpath：workspaceFolders 的 fsPath 保留打开时的大小写
    // （s:\… vs 盘符真身 S:\…），原样下发会让 pi 的信任根比对失败 →
    // 受限模式+手动信任。真实盘符路径才与信任存储一致。
    const dir = cwd ? await fsp.realpath(cwd).catch(() => cwd) : cwd;
    const key = `new:${dir}`;
    const panel = sessionPanels.forKey(key);
    void ensureServer();
    await panel.reveal(dir, sessionPanels.column());
    // 标题口径：New session + 目录基名——空 tab 也能认出挂在哪个工作区
    // （"Pi — pi" 与既有 session 标题撞型，无法区分"新建中"与已落地）。
    const tag = label ?? (dir ? path.basename(dir) : "");
    panel.setTitleOverride(tag ? `Pi — New session (${tag})` : "Pi — New session");
  };

  // editor/title/context 的双轨制（VS Code 弹菜单前把 resourceContext
  // 换成被点编辑器的）：when 用 resourceFilename 命中
  // `webview-<providerId>-<uuid>`（providerId = mainThreadWebview-<viewType>
  // ——新版 webview 才带 resource）精确到被点 webview tab；旧版 webview
  // 无 resource，回退 activeWebviewPanelId && !resourceSet——"被点 tab 无
  // resource"一把覆盖全部资源型 tab（file/untitled/git/vscode/diff…），
  // 残留仅旧版下其他无 resource 异类 tab（终端/输出）+pi 激活时误显示，
  // 命令入参不符即空操作兜底。
  // 命令入参 = 被点 tab 的 resource URI——含唯一 viewType 即精确归属；
  // 拿不到（旧版无 resource）才回退激活面板。
  const tabPanelFor = (arg: unknown): PiWebWebviewPanel | undefined => {
    const uri = arg as { scheme?: unknown; path?: unknown } | undefined;
    const scheme = typeof uri?.scheme === "string" ? uri.scheme : "";
    const path = typeof uri?.path === "string" ? uri.path : "";
    outputChannel().appendLine(`[tab-menu] arg scheme=${scheme} path=${path}`);
    if (scheme === "vscode-webview" || path.includes("webview-panel/webview-")) {
      return (
        sessionPanels.byViewTypeUri(path) ??
        (path.includes(`${provider.viewType}-`) ? provider : undefined) ??
        (path.includes(`${settingsPanel.viewType}-`) ? settingsPanel : undefined) ??
        sessionPanels.active()
      );
    }
    if (scheme) return undefined;
    return sessionPanels.active();
  };

  const openSession = async (id: string, title?: string, viewColumn?: vscode.ViewColumn) => {
    // 孤儿占位交换：树点开命中死 tab → 关占位，原组原列+死 tab 标题
    // 透传给新面板。会话可能被外部删掉——补一拍拿真相（cwd/标题都依赖
    // sessionById），查无此会话时死 tab 标题兜底。
    const orphan = orphans.takeSession(id);
    if (orphan) {
      await closeOrphan(orphan);
      if (!sessionsProvider.sessionById(id)) await sessionsProvider.reload();
      viewColumn ??= orphanColumn(orphan);
      title ??= titleFromOrphanLabel(orphan.tab.label ?? orphan.label);
    }
    // 面板 cwd 用会话自己的目录——跨项目点开不受当前配置 cwd 影响。
    const cwd = sessionsProvider.sessionById(id)?.cwd
      ?? resolveConfiguredCwd()
      ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      ?? "";
    const perSession = piConfig().get<string>("sessionTabs", "perSession") === "perSession";
    if (!perSession) {
      void ensureServer();
      const mainOrphan = orphans.takeKind("main");
      if (mainOrphan) await closeOrphan(mainOrphan);
      await provider.reveal(cwd, viewColumn ?? orphanColumn(mainOrphan) ?? openViewColumn(), id);
      return;
    }
    const panel = sessionPanels.forKey(id);
    void ensureServer();
    await panel.reveal(cwd, viewColumn ?? sessionPanels.column(), id);
    if (title) panel.setTitleOverride(`Pi — ${title}`);
  };

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
      // 该会话的占位孤儿与主面板占位都可能存在——两处都收走，重影清零。
      const sessionOrphan = orphans.takeSession(id);
      const mainOrphan = orphans.takeKind("main");
      for (const o of [sessionOrphan, mainOrphan]) if (o) await closeOrphan(o);
      await provider.reveal(
        cwd,
        orphanColumn(sessionOrphan) ?? orphanColumn(mainOrphan) ?? openViewColumn(),
        id,
      );
    },
    openSession,
    openProject: async (cwd: string, label?: string) => {
      await newSessionAt(cwd, label);
    },
  });

  // 空态/工具栏的新建会话：cwd 跟随配置优先、工作区根兜底的既有口径。
  context.subscriptions.push(
    vscode.commands.registerCommand("piIde.sessions.newSession", async () => {
      const cwd = resolveConfiguredCwd()
        ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        ?? "";
      await newSessionAt(cwd);
    }),
    // tab 右键动作：归属按"被右键的 tab"解析——菜单入参是该 tab（label
    // = panel.title 匹配）；拿不到入参才回退激活面板。会话 tab 与 composer
    // tab 同样适用；cwd/session 取面板记录的 reveal 入参。
    vscode.commands.registerCommand("piIde.tab.copyWorkspacePath", async (arg?: unknown) => {
      const dir = tabPanelFor(arg)?.cwd;
      if (dir) await vscode.env.clipboard.writeText(dir);
    }),
    // 从会话 tab 定位到 Pi Sessions 树中对应条目（选中+聚焦+展开父链
    // ——视觉区分=树选中态）。区外会话 revealInExplorer 会误触 openFolder
    // 换掉本窗工作区，不可复用；树定位无此限。composer 无 sessionId 时空操作。
    vscode.commands.registerCommand("piIde.tab.revealInSessions", async (arg?: unknown) => {
      const id = tabPanelFor(arg)?.session;
      const item = id ? sessionsProvider.revealItemFor(id) : undefined;
      if (item) await sessionsView.reveal(item, { select: true, focus: true, expand: true });
    }),
    // tab 右键动作：整页重载——webview 快捷键不穿透进 iframe，菜单是
    // 面板卡死/OOPIF 合成器 wedge（DOM 完整但不上屏）时最近的逃生通道。
    // 所有 pi 面板类型（会话/composer/settings/主面板）共用此路径。
    vscode.commands.registerCommand("piIde.tab.reloadPage", async (arg?: unknown) => {
      tabPanelFor(arg)?.reloadPage();
    }),
  );

  // 跨窗"打开会话"交接的消费端（pending-open.ts）：别窗口把异区会话
  // 投递到本工作区窗口来打开。activate 首轮扫描覆盖新窗场景，fs.watch
  // 常驻覆盖本窗早已激活的场景。
  const pendingWatcher = watchPendingOpens({
    workspaceRoots: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    consume: (id) => {
      const s = sessionsProvider.sessionById(id);
      void openSession(id, s ? sessionTitle(s) : undefined);
    },
    log: (l) => outputChannel().appendLine(`[pending-open] ${l}`),
  });
  if (pendingWatcher) context.subscriptions.push(pendingWatcher);

  // 孤儿面板接管（扩展升级/宿主重启后 tab 还在、扩展侧对象已死）——
  // 枚举→serializer 注册→懒占位：点开 deserialize 原地收养，reveal/
  // openSession 命中由本文件各入口做原位交换，编排在 panel-revival.ts；
  // 此处只接宿主侧依赖。sessionExists：清单已载而查无此会话才算"已删"
  // ——未加载时乐观收养（误杀真孤儿的代价比多活一个占位高）。
  registerOrphanPanelRevival(context, {
    sessionPanels,
    mainPanel: provider,
    settingsPanel,
    orphans,
    sessionExists: (id) =>
      sessionsProvider.listLoaded ? !!sessionsProvider.sessionById(id) : undefined,
    // 清单加载/刷新时补一轮枚举——重载下 tab 恢复晚于激活，清单到达
    // 时编辑器多半已就位；onDidChangeTabs 漏报时这是第二道兜底。
    onExtraEnumerate: sessionsProvider.onDidChangeTreeData,
    log: (l) => outputChannel().appendLine(l),
  });

  return { settingsPanel };
}
