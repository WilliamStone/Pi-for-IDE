import * as vscode from "vscode";
import { logLifecycle, outputChannel } from "./server-status";
import {
  groupByProject,
  isInWorkspace,
  recentSessions,
  relTime,
  sessionTitle,
  topLevelSessions,
  workspaceRelation,
  type ApiSession,
  type ProjectGroup,
  type SessionsViewMode,
} from "./sessions-model";

/**
 * 原生会话侧栏（Activity Bar → Sessions）：TreeDataProvider 直连本地
 * pi-web 的 /api/sessions 与 /api/agent/running——导航权归宿主，pi-web
 * 侧栏被原生视图替代。过滤栏 = view/title 工具按钮（TreeView 不能内嵌
 * 输入控件，这是 VS Code 的标准形态：参照 Outline/Explorer）。
 *
 * 轮询：可见时 2.5s 打一次 /api/agent/running（与 web 侧栏同节奏），
 * sessionListVersion/uiStateRevision 变了才拉对应清单——空转零成本。
 */

const POLL_MS = 2_500;

interface RunningSnapshot {
  sessionListVersion: number;
  runningSessionIds?: string[];
  awaitingInputSessionIds?: string[];
  sessionUiStateRevision?: number | null;
}

interface UiState {
  sessions?: Record<string, { pinnedAt?: number; archivedAt?: number }>;
  projects?: Record<string, { pinnedAt?: number; root: string }>;
  projectNames?: Record<string, string>;
}

async function apiJson<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export class SessionsTreeProvider extends vscode.Disposable implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private sessions: ApiSession[] = [];
  private runningIds = new Set<string>();
  private awaitingIds = new Set<string>();
  private pinnedIds = new Set<string>();
  private archivedIds = new Set<string>();
  private pinnedProjects = new Set<string>();
  private projectNames = new Map<string, string>();

  private workspaceOnly: boolean;
  private mode: SessionsViewMode;
  private listVersion = -1;
  private uiRevision: number | null = null;
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private visible = false;
  private lastViewSig = "";
  private lastStarting = false;
  private lastStartStage: string | undefined;
  // 启动耗时里程碑埋点：base 首次解析、清单首次渲染各记一笔（时间戳
  // 前缀即距启动起点的墙钟差）——"数据什么时候出来的"不再靠猜。
  private loggedBase = false;
  private loggedList = false;

  /** 已解析的服务 origin；未启动 → undefined（绝不 spawn）。 */
  private readonly getBaseUrl: () => Promise<string | undefined>;
  private readonly memento: vscode.Memento;
  private readonly workspaceRoots: () => string[];
  /** 服务器解析/启动在途（PiIdeServer.starting）——hint 文案据此区分。 */
  private readonly isStarting?: () => boolean;
  /** 启动链当前阶段文案（currentServerStatus）——starting 时拼进 hint。 */
  private readonly startingStage?: () => string | undefined;

  // strip-types 不支持构造器参数属性——显式字段（可直测）。
  constructor(
    getBaseUrl: () => Promise<string | undefined>,
    memento: vscode.Memento,
    workspaceRoots: () => string[],
    isStarting?: () => boolean,
    startingStage?: () => string | undefined,
  ) {
    super(() => this.dispose());
    this.getBaseUrl = getBaseUrl;
    this.memento = memento;
    this.workspaceRoots = workspaceRoots;
    this.isStarting = isStarting;
    this.startingStage = startingStage;
    this.workspaceOnly = memento.get("piIde.sessions.workspaceOnly", false);
    this.mode = memento.get<SessionsViewMode>("piIde.sessions.viewMode", "byProject");
  }

  override dispose() {
    clearTimeout(this.timer);
    this.changeEmitter.dispose();
  }

  isWorkspaceOnly(): boolean {
    return this.workspaceOnly;
  }

  sessionById(id: string): ApiSession | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  /** 状态栏/通知读——每次成功轮询后的快照。 */
  get awaitingSessionIds(): ReadonlySet<string> {
    return this.awaitingIds;
  }
  get runningSessionIds(): ReadonlySet<string> {
    return this.runningIds;
  }

  /** ui-state 的项目显示名（rename-project 写入），未命名时 undefined。 */
  projectDisplayName(key: string): string | undefined {
    return this.projectNames.get(key);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) void this.tick();
    else clearTimeout(this.timer);
  }

  async setWorkspaceOnly(value: boolean): Promise<void> {
    this.workspaceOnly = value;
    await this.memento.update("piIde.sessions.workspaceOnly", value);
    this.changeEmitter.fire();
  }

  async cycleViewMode(): Promise<void> {
    this.mode = this.mode === "byProject" ? "recent" : "byProject";
    await this.memento.update("piIde.sessions.viewMode", this.mode);
    this.changeEmitter.fire();
  }

  /** 手动刷新（view/title 按钮）——绕过版本判等直接拉一遍。 */
  async reload(): Promise<void> {
    this.listVersion = -1;
    this.uiRevision = null;
    await this.pull();
    this.changeEmitter.fire();
  }

  private async tick(): Promise<void> {
    clearTimeout(this.timer);
    if (!this.visible) return;
    await this.pull();
    if (this.visible) this.timer = setTimeout(() => void this.tick(), POLL_MS);
  }

  /** 探活 + 按需拉清单：version/revision 没变就一行请求也不多发。 */
  private async pull(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const base = await this.getBaseUrl();
      if (!base) {
        // 离线态下 hint 文案由 isStarting 驱动——off↔starting 翻转也要重绘，
        // 否则 "starting" 提示永远出不来。
        const starting = this.isStarting?.() ?? false;
        const stage = starting ? this.startingStage?.() : undefined;
        const hintFlipped =
          starting !== this.lastStarting || stage !== this.lastStartStage;
        this.lastStarting = starting;
        this.lastStartStage = stage;
        if (this.sessions.length || this.listVersion !== -1) {
          this.sessions = [];
          this.listVersion = -1;
          this.changeEmitter.fire();
        } else if (hintFlipped) {
          this.changeEmitter.fire();
        }
        return;
      }
      if (!this.loggedBase) {
        this.loggedBase = true;
        logLifecycle(`sessions poll: base resolved → ${base}`);
      }
      const snap = await apiJson<RunningSnapshot>(base, "/api/agent/running");
      this.runningIds = new Set(snap.runningSessionIds ?? []);
      this.awaitingIds = new Set(snap.awaitingInputSessionIds ?? []);

      if (snap.sessionListVersion !== this.listVersion) {
        const raw = await apiJson<{
          sessions: ApiSession[];
          runningSessionIds?: string[];
          awaitingInputSessionIds?: string[];
        }>(base, "/api/sessions");
        this.sessions = topLevelSessions(raw.sessions ?? []);
        this.listVersion = snap.sessionListVersion;
        if (!this.loggedList) {
          this.loggedList = true;
          logLifecycle(`sessions listed: ${this.sessions.length} session(s)`);
        }
        // 会话清单自带 running 快照——顺手刷新，不用等下一轮 running 轮询。
        this.runningIds = new Set(raw.runningSessionIds ?? []);
        this.awaitingIds = new Set(raw.awaitingInputSessionIds ?? []);
      }
      const rev = snap.sessionUiStateRevision ?? null;
      if (rev !== this.uiRevision) {
        const { state } = await apiJson<{ state: UiState }>(base, "/api/sessions/ui-state");
        const entries = state.sessions ?? {};
        this.pinnedIds = new Set(Object.keys(entries).filter((id) => entries[id].pinnedAt !== undefined));
        this.archivedIds = new Set(Object.keys(entries).filter((id) => entries[id].archivedAt !== undefined));
        this.pinnedProjects = new Set(Object.keys(state.projects ?? {}));
        this.projectNames = new Map(Object.entries(state.projectNames ?? {}));
        this.uiRevision = rev;
      }
      // 渲染签名判变才通知视图——每次成功轮询无脑 fire 会让 TreeView
      // 每 2.5s 闪一次刷新进度条。签名覆盖 getChildren 读的每个字段
      // （含渲染后的 relTime 文本——"1m ago"→"2m ago"是真变更，该闪）。
      const sig = this.viewSignature();
      if (sig !== this.lastViewSig) {
        this.lastViewSig = sig;
        this.changeEmitter.fire();
      }
    } catch (error) {
      // 服务器未就绪/正在重启——保旧数据，下一轮再来；记录一笔便于诊断。
      outputChannel().appendLine(`[sessions-tree] poll failed: ${error}`);
    } finally {
      this.polling = false;
    }
  }

  /** 渲染会读的字段全打包成签名——未变即视图上无可感差异，不闪刷新。 */
  private viewSignature(): string {
    return JSON.stringify({
      v: this.listVersion,
      s: this.sessions.map((s) => [
        s.id,
        sessionTitle(s),
        relTime(s.modified),
        s.messageCount ?? 0,
        s.projectRoot ?? s.cwd ?? "",
      ]),
      r: [...this.runningIds].sort(),
      a: [...this.awaitingIds].sort(),
      p: [...this.pinnedIds].sort(),
      ar: [...this.archivedIds].sort(),
      pp: [...this.pinnedProjects].sort(),
      pn: [...this.projectNames.entries()].sort(([a], [b]) => a.localeCompare(b)),
    });
  }

  private filteredSessions(): ApiSession[] {
    if (!this.workspaceOnly) return this.sessions;
    const roots = this.workspaceRoots();
    if (!roots.length) return [];
    return this.sessions.filter((s) => isInWorkspace(s, roots));
  }

  /** 命令侧查会话目录——目录类操作（reveal/新窗/终端）的落点。 */
  sessionDir(id: string): string | undefined {
    return this.sessions.find((s) => s.id === id)?.cwd ?? undefined;
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element instanceof ProjectItem) return element.sessionItems;
    if (element) return [];
    if (this.listVersion === -1 && this.sessions.length === 0) {
      if (this.isStarting?.()) {
        const stage = this.startingStage?.();
        return [new HintItem(`Server is starting…${stage ? ` — ${stage}` : ""}`)];
      }
      return [new HintItem("Server not running or is starting…")];
    }
    const list = this.filteredSessions();
    if (!list.length) {
      return [new HintItem(this.workspaceOnly ? "No sessions in this workspace" : "No sessions yet")];
    }
    if (this.mode === "recent") {
      return recentSessions(list).map((s) => this.sessionItem(s, true));
    }
    // pinned 项目组置前——pi-web 的 Pinned 分区对应物；组内顺序按
    // 各自最新会话活动排序（拖拽 projectOrder 次序 v2 再做，TreeView
    // 无对应交互先不读）。
    const groups = groupByProject(list);
    groups.sort((a, b) => {
      const ap = this.pinnedProjects.has(a.key) ? 1 : 0;
      const bp = this.pinnedProjects.has(b.key) ? 1 : 0;
      return bp - ap;
    });
    return groups.map((g) => this.projectItem(g));
  }

  private projectItem(group: ProjectGroup): ProjectItem {
    const pinned = this.pinnedProjects.has(group.key);
    const displayName = this.projectNames.get(group.key);
    const label = `${displayName ?? group.label}${group.branch ? ` (${group.branch})` : ""}`;
    const item = new ProjectItem(
      label,
      group.sessions
        .sort((a, b) => Number(this.pinnedIds.has(b.id)) - Number(this.pinnedIds.has(a.id)))
        .map((s) => this.sessionItem(s, false)),
      group,
    );
    item.description = `${group.sessions.length}`;
    item.tooltip = new vscode.MarkdownString(
      `**${group.root}**${group.isWorktree ? "\n\nworktree" : ""}${pinned ? "\n\npinned" : ""}`,
    );
    item.iconPath = new vscode.ThemeIcon(
      pinned ? "pinned" : group.isWorktree ? "git-branch" : "folder",
    );
    item.contextValue = `piIde.project${pinned ? ".pinned" : ""}`;
    item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    return item;
  }

  private sessionItem(s: ApiSession, flat: boolean): vscode.TreeItem {
    const running = this.runningIds.has(s.id);
    const awaiting = this.awaitingIds.has(s.id);
    const pinned = this.pinnedIds.has(s.id);
    const archived = this.archivedIds.has(s.id);
    const item = new vscode.TreeItem(sessionTitle(s));
    item.id = `piIde.session.${s.id}`;
    const desc: string[] = [];
    if (flat && (s.projectRoot ?? s.cwd)) desc.push(s.projectRoot ? s.projectRoot.split(/[\\/]/).pop()! : s.cwd!);
    desc.push(relTime(s.modified));
    if (s.messageCount) desc.push(`${s.messageCount} msgs`);
    item.description = desc.join(" · ");
    item.tooltip = new vscode.MarkdownString(
      `**${sessionTitle(s)}**\n\n${s.cwd ?? ""}\n\n${s.created.slice(0, 16)} · ${relTime(s.modified)}`,
    );
    // 状态图标优先（running/awaiting 是活状态），否则 pinned 给图钉。
    // TreeItem 单 iconPath——pinned+running 时图钉让位，pin 仍靠排序置前。
    item.iconPath = new vscode.ThemeIcon(
      running ? "pulse" : awaiting ? "bell-dot" : pinned ? "pinned" : "comment",
      running
        ? new vscode.ThemeColor("testing.iconPassed")
        : awaiting
          ? new vscode.ThemeColor("testing.iconQueued")
          : pinned
            ? new vscode.ThemeColor("textLink.foreground")
            : undefined,
    );
    // 目录类操作的显隐旗标：hasDir=有会话目录（三个操作的前提）；
    // wsSub=目录在工作区子树内（Explorer 定位）；wsOther=目录非工作区根
    // （新窗打开）。情形1（cwd=根）只留 hasDir → 只显示终端。
    let wsFlags = "";
    if (s.cwd) {
      const rel = workspaceRelation(s.cwd, this.workspaceRoots());
      wsFlags = `.hasDir${rel === "sub" ? ".wsSub" : ""}${rel === "sub" || rel === "out" ? ".wsOther" : ""}`;
    }
    item.contextValue = `piIde.session${running ? ".running" : ""}${pinned ? ".pinned" : ""}${archived ? ".archived" : ""}${wsFlags}`;
    item.command = {
      command: "piIde.session.open",
      title: "Open session",
      arguments: [s.id, sessionTitle(s)],
    };
    return item;
  }
}

class ProjectItem extends vscode.TreeItem {
  readonly sessionItems: vscode.TreeItem[];
  readonly group: ProjectGroup;

  constructor(label: string, sessionItems: vscode.TreeItem[], group: ProjectGroup) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.sessionItems = sessionItems;
    this.group = group;
  }
}

class HintItem extends vscode.TreeItem {
  constructor(text: string) {
    super(text, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "piIde.hint";
    this.iconPath = new vscode.ThemeIcon("info");
  }
}

/** 会话行的全部动作：读改删直连本地 API，完成后 reload 拉真相。 */
export function registerSessionCommands(
  context: vscode.ExtensionContext,
  deps: {
    getBaseUrl: () => Promise<string | undefined>;
    ensureServer: () => Promise<unknown>;
    provider: SessionsTreeProvider;
    openSession: (id: string, title?: string) => Promise<void>;
    /** 在该项目目录打开新会话（composer cwd=projectRoot，无 session 深链）。 */
    openProject: (cwd: string, label?: string) => Promise<void>;
    /** 会话在完整页面打开（不带 view=chat）——精简掉的入口的过渡通道。 */
    openSessionFull: (id: string) => Promise<void>;
  },
): void {
  const { getBaseUrl, provider } = deps;
  const post = async <T>(path: string, body?: unknown, method = "POST"): Promise<T | undefined> => {
    const base = await getBaseUrl();
    if (!base) return undefined;
    return apiJson<T>(base, path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };

  context.subscriptions.push(
    // 节点点击走 item.command.arguments=[id,title]；右键/inline 按钮由
    // view/item/context 触发，VS Code 传的是整个 TreeItem——两种都归一到
    // 会话 id，否则 inline 图标会每次新开一个 ?session=[object Object] 的
    // tab（首页+错误标题，且不与会话对应）。
    vscode.commands.registerCommand(
      "piIde.session.open",
      async (arg: string | vscode.TreeItem, title?: string) => {
        const id = typeof arg === "string" ? arg : sessionIdOf(arg);
        const name = title ?? (typeof arg !== "string" && typeof arg.label === "string" ? arg.label : undefined);
        void deps.ensureServer();
        await deps.openSession(id, name);
      },
    ),

    vscode.commands.registerCommand("piIde.session.rename", async (item: vscode.TreeItem) => {
      const id = sessionIdOf(item);
      const name = await vscode.window.showInputBox({
        title: "Rename session",
        prompt: "New name (empty clears it)",
        value: typeof item.label === "string" ? item.label : "",
      });
      if (name === undefined) return;
      await post(`/api/sessions/${id}`, { name }, "PATCH");
      await provider.reload();
    }),

    vscode.commands.registerCommand("piIde.session.delete", async (item: vscode.TreeItem) => {
      const id = sessionIdOf(item);
      const yes = await vscode.window.showWarningMessage(
        `Delete session "${typeof item.label === "string" ? item.label : id}"?`,
        { modal: true },
        "Delete",
      );
      if (yes !== "Delete") return;
      await post(`/api/sessions/${id}`, undefined, "DELETE");
      await provider.reload();
    }),

    vscode.commands.registerCommand("piIde.session.fork", async (item: vscode.TreeItem) => {
      const id = sessionIdOf(item);
      const out = await post<{ sessionId?: string; id?: string }>(`/api/sessions/${id}/fork`);
      const forkId = out?.sessionId ?? out?.id;
      await provider.reload();
      if (forkId) await deps.openSession(forkId);
    }),

    vscode.commands.registerCommand("piIde.session.pin", async (item: vscode.TreeItem) => {
      await post("/api/sessions/ui-state", { action: "set", ids: [sessionIdOf(item)], pinned: true });
      await provider.reload();
    }),
    vscode.commands.registerCommand("piIde.session.unpin", async (item: vscode.TreeItem) => {
      await post("/api/sessions/ui-state", { action: "set", ids: [sessionIdOf(item)], pinned: false });
      await provider.reload();
    }),
    vscode.commands.registerCommand("piIde.session.archive", async (item: vscode.TreeItem) => {
      await post("/api/sessions/ui-state", { action: "set", ids: [sessionIdOf(item)], archived: true });
      await provider.reload();
    }),
    vscode.commands.registerCommand("piIde.session.unarchive", async (item: vscode.TreeItem) => {
      await post("/api/sessions/ui-state", { action: "set", ids: [sessionIdOf(item)], archived: false });
      await provider.reload();
    }),

    // ── 项目组操作：置顶/重命名/在此开新会话 ──────────────────────────
    vscode.commands.registerCommand("piIde.project.pin", async (item: ProjectItem) => {
      await post("/api/sessions/ui-state", {
        action: "pin-project", projectKey: item.group.key, root: item.group.root, pinned: true,
      });
      await provider.reload();
    }),
    vscode.commands.registerCommand("piIde.project.unpin", async (item: ProjectItem) => {
      await post("/api/sessions/ui-state", {
        action: "pin-project", projectKey: item.group.key, root: item.group.root, pinned: false,
      });
      await provider.reload();
    }),
    vscode.commands.registerCommand("piIde.project.rename", async (item: ProjectItem) => {
      const name = await vscode.window.showInputBox({
        title: "Rename project",
        prompt: "Display name for this project group (empty clears it)",
        value: typeof item.label === "string" ? item.label.replace(/\s*\(.*\)$/, "") : "",
      });
      if (name === undefined) return;
      await post("/api/sessions/ui-state", {
        action: "rename-project", projectKey: item.group.key, name: name.trim() || null,
      });
      await provider.reload();
    }),
    vscode.commands.registerCommand("piIde.project.newSession", async (item: ProjectItem) => {
      void deps.ensureServer();
      await deps.openProject(
        item.group.root || item.group.sessions[0]?.cwd || "",
        provider.projectDisplayName(item.group.key) ?? item.group.label,
      );
    }),
    vscode.commands.registerCommand("piIde.session.openFull", async (arg: string | vscode.TreeItem) => {
      const id = typeof arg === "string" ? arg : sessionIdOf(arg);
      void deps.ensureServer();
      await deps.openSessionFull(id);
    }),

    // ── 目录类操作：走宿主原生能力（Explorer 定位 / 新窗 / 集成终端），
    // 显隐由 contextValue 的 wsSub/wsOther/hasDir 旗标控制，cwd 缺失时静默返回。
    vscode.commands.registerCommand("piIde.session.revealInExplorer", async (item: vscode.TreeItem) => {
      const dir = provider.sessionDir(sessionIdOf(item));
      if (dir) await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(dir));
    }),
    vscode.commands.registerCommand("piIde.session.openInNewWindow", async (item: vscode.TreeItem) => {
      const dir = provider.sessionDir(sessionIdOf(item));
      // 同产品系新窗（VSCodium/Devin/灵码等）——openFolder 开的是本宿主。
      if (dir) await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(dir), { forceNewWindow: true });
    }),
    vscode.commands.registerCommand("piIde.session.openInTerminal", (item: vscode.TreeItem) => {
      const dir = provider.sessionDir(sessionIdOf(item));
      if (!dir) return;
      vscode.window.createTerminal({
        cwd: vscode.Uri.file(dir),
        name: typeof item.label === "string" ? item.label : "Pi",
      }).show();
    }),

    vscode.commands.registerCommand("piIde.sessions.refresh", () => provider.reload()),
    // 两个命令图标化同一个开关：过滤态显示 $(list-filter)，全部态显示 $(globe)。
    vscode.commands.registerCommand("piIde.sessions.filterWorkspace", async () => {
      await provider.setWorkspaceOnly(true);
      await vscode.commands.executeCommand("setContext", "piIde.sessions.workspaceOnly", true);
    }),
    vscode.commands.registerCommand("piIde.sessions.showAll", async () => {
      await provider.setWorkspaceOnly(false);
      await vscode.commands.executeCommand("setContext", "piIde.sessions.workspaceOnly", false);
    }),
    vscode.commands.registerCommand("piIde.sessions.cycleViewMode", () => provider.cycleViewMode()),
  );
}

import { sessionIdOf } from "./session-id";
