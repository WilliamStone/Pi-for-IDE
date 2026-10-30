import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import { logLifecycle, outputChannel } from "./server-status";
import {
  forkForest,
  groupByProject,
  isInWorkspace,
  recentSessions,
  relTime,
  sessionTitle,
  topLevelSessions,
  truncateToCols,
  workspaceRelation,
  type ApiSession,
  type ForkNode,
  type ProjectGroup,
  type SessionsViewMode,
} from "./sessions-model";
import { CONFIG_SECTION, piConfig } from "./config";

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

// TreeView 无宽度 API，行尾 meta（时间·条数）会被长标题顶出右缘。标题
// 按可配视觉列宽自截：默认 32 列 ≈ 常规侧栏宽度下给 meta 留 15+ 列；
// 8 列保底防预算设太小标题消失；0 关闭。tooltip 始终是全名。
const DEFAULT_TITLE_MAX_COLS = 32;
const MIN_TITLE_COLS = 8;

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

/** meta 副行的 resourceUri scheme——FileDecorationProvider 按它染暗 label。 */
export const META_ROW_SCHEME = "pi-ide-meta";

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

  /** 副行占位图标（透明 SVG）——占住图标槽，meta 文本与会话标题同列起始。
   *  由 sessions-feature 注入（extensionUri 侧拼路径）；未注入则副行无图标。 */
  metaIconUri?: vscode.Uri;

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

  /** 清单是否成功加载过——孤儿 deserialize 侧判"会话已删"用：未加载
   *  时无法断言缺失（服务未达/还没轮过），只能乐观收养。 */
  get listLoaded(): boolean {
    return this.listVersion !== -1;
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
    const order: SessionsViewMode[] = ["byProject", "recent", "fork"];
    this.mode = order[(order.indexOf(this.mode) + 1) % order.length];
    await this.memento.update("piIde.sessions.viewMode", this.mode);
    this.changeEmitter.fire();
  }

  /** 配置驱动的重渲染（标题截断宽度等纯视图项）——数据不动仅重铺。 */
  refreshView(): void {
    this.changeEmitter.fire();
  }

  // 折叠双态：TreeView 无 collapse API（内置 collapseAll 单向）。让组
  // id 携带"折叠代际"，每次切换发新 id → VS Code 当新节点 → 按
  // collapsibleState 初始态铺，确定性地全收/全展，不碰焦点不下发
  // workbench 命令。
  private collapseGen = 0;
  private allCollapsed = false;
  // 展开态账目：手动折叠/展开与命令按钮共享，决定 allCollapsed context。
  // 首次折叠事件前所有组都处于默认展开——用 seeded 惰性播种全量键。
  private expandedGroups = new Set<string>();
  private expandSeeded = false;

  setAllCollapsed(collapsed: boolean): void {
    this.allCollapsed = collapsed;
    this.collapseGen++;
    this.expandSeeded = true;
    this.expandedGroups = collapsed ? new Set() : new Set(this.topGroupKeys());
    this.changeEmitter.fire();
  }

  isAllCollapsed(): boolean {
    return this.expandSeeded && this.expandedGroups.size === 0;
  }

  noteExpanded(key: string): void {
    this.expandedGroups.add(key);
  }

  noteCollapsed(key: string): void {
    if (!this.expandSeeded) {
      this.expandSeeded = true;
      for (const k of this.topGroupKeys()) this.expandedGroups.add(k);
    }
    this.expandedGroups.delete(key);
  }

  private topGroupKeys(): string[] {
    return this.getChildren()
      .filter((x): x is ProjectItem => x instanceof ProjectItem)
      .map((x) => x.group.key);
  }

  get viewMode(): SessionsViewMode {
    return this.mode;
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

  /** 状态广播触发的即时补拍——服务绑口/握手推进时不必等 2.5s 节拍。
   *  不可见但清单从未加载也放行：onDidChangeVisibility 实测可滞后 ~10s
   *  才投递（点开侧栏到事件到达），先把数据备好，视图一开即直出；
   *  已加载过则维持"不可见不轮询"的省流口径。 */
  kick(): void {
    if (!this.visible && this.listVersion !== -1) return;
    void this.pull();
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

  /** session→树条目索引（父链：项目节点或 fork 父会话）——reveal 需要 getParent 解析。 */
  private readonly itemIndex = new Map<string, { item: vscode.TreeItem; parent?: vscode.TreeItem }>();

  /** tab 右键"在会话列表显示"的条目——索引优先，未渲染到时按模式重建。 */
  revealItemFor(id: string): vscode.TreeItem | undefined {
    const cached = this.itemIndex.get(id);
    if (cached) return cached.item;
    const s = this.sessionById(id);
    return s ? this.sessionItem(s, this.mode === "recent") : undefined;
  }

  getParent(element: vscode.TreeItem): vscode.TreeItem | undefined {
    if (element instanceof ProjectItem) return undefined;
    if (this.mode === "recent") return undefined;
    const id = element.id?.startsWith("piIde.session.") ? sessionIdOf(element) : undefined;
    if (!id) return undefined;
    const cached = this.itemIndex.get(id);
    if (cached?.parent) return cached.parent;
    const s = this.sessionById(id);
    if (!s) return undefined;
    const g = groupByProject(this.filteredSessions()).find((x) => x.sessions.some((y) => y.id === id));
    return g ? this.projectItem(g) : undefined;
  }

  /** fork 模式下挂到会话行下的 fork 子会话（item → 子行集）。 */
  private readonly forkChildren = new WeakMap<vscode.TreeItem, vscode.TreeItem[]>();

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element instanceof ProjectItem) return element.sessionItems;
    if (element) return this.forkChildren.get(element) ?? [];
    if (this.listVersion === -1 && this.sessions.length === 0) {
      if (this.isStarting?.()) {
        const stage = this.startingStage?.();
        return [new HintItem(`Server is starting…${stage ? ` — ${stage}` : ""}`)];
      }
      return [new HintItem("Server not running or is starting…")];
    }
    const list = this.filteredSessions();
    if (!list.length) {
      // 空态给出路而非死胡同：新建会话（本工作区 cwd 的 composer）；
      // 过滤态顺带提供"看全部会话"的出口——异区会话本就存在，只是被滤掉。
      const hint = new HintItem(this.workspaceOnly ? "No sessions in this workspace" : "No sessions yet");
      const add = new vscode.TreeItem("New session");
      add.command = { command: "piIde.sessions.newSession", title: "New session" };
      add.iconPath = new vscode.ThemeIcon("add");
      add.contextValue = "piIde.hint";
      const items: vscode.TreeItem[] = [hint, add];
      if (this.workspaceOnly) {
        const all = new vscode.TreeItem("Show all sessions");
        all.command = { command: "piIde.sessions.showAll", title: "Show all sessions" };
        all.iconPath = new vscode.ThemeIcon("globe");
        all.contextValue = "piIde.hint";
        items.push(all);
      }
      return items;
    }
    if (this.mode === "recent") {
      return recentSessions(list).flatMap((s) => this.sessionRows(s, true));
    }
    // 排序三档：pinned 置前 → 本工作区项目 → 异区项目（异区是次频入口，
    // 沉底降干扰）；各档内保持 groupByProject 的最新活动序（拖拽
    // projectOrder 次序 v2 再做，TreeView 无对应交互先不读）。
    const groups = groupByProject(list);
    const roots = this.workspaceRoots();
    groups.sort((a, b) => {
      const ap = this.pinnedProjects.has(a.key) ? 1 : 0;
      const bp = this.pinnedProjects.has(b.key) ? 1 : 0;
      if (bp !== ap) return bp - ap;
      const aw = workspaceRelation(a.root, roots) === "out" ? 0 : 1;
      const bw = workspaceRelation(b.root, roots) === "out" ? 0 : 1;
      return bw - aw;
    });
    return groups.map((g) => this.projectItem(g));
  }

  private projectItem(group: ProjectGroup): ProjectItem {
    const pinned = this.pinnedProjects.has(group.key);
    const displayName = this.projectNames.get(group.key);
    const label = `${displayName ?? group.label}${group.branch ? ` (${group.branch})` : ""}`;
    const sorted = group.sessions
      .sort((a, b) => Number(this.pinnedIds.has(b.id)) - Number(this.pinnedIds.has(a.id)));
    const item = new ProjectItem(
      label,
      this.mode === "fork"
        ? forkForest(sorted).flatMap((n) => this.forkRows(n))
        : sorted.flatMap((s) => this.sessionRows(s, false)),
      group,
    );
    for (const c of item.sessionItems) {
      if (c.id) this.itemIndex.set(sessionIdOf(c), { item: c, parent: item });
    }
    item.description = `${group.sessions.length}`;
    item.tooltip = new vscode.MarkdownString(
      `**${group.root}**${group.isWorktree ? "\n\nworktree" : ""}${pinned ? "\n\npinned" : ""}`,
    );
    // 异工作区项目：file-symlink-directory 字形（文件夹叠加右上弯箭头，
    // "目录在别处"的快捷方式语义）+ 降色双保险——TreeItem 无字体样式
    // API，且单靠颜色/微调字形在多数主题里不够显眼。给跳窗按钮的旗标。
    const foreign = workspaceRelation(group.root, this.workspaceRoots()) === "out";
    item.iconPath = new vscode.ThemeIcon(
      pinned ? "pinned" : group.isWorktree ? "git-branch" : foreign ? "file-symlink-directory" : "folder",
      foreign ? new vscode.ThemeColor("list.deemphasizedForeground") : undefined,
    );
    item.contextValue = `piIde.project${pinned ? ".pinned" : ""}${foreign ? ".wsForeign" : ""}`;
    // 代际 id：折叠切换产生新 id → 折叠态按 collapsibleState 初始值重铺；
    // 数据刷新时代不变 → 用户展开态跨刷新保持。
    item.id = `piIde.project.${this.collapseGen}.${group.key}`;
    item.collapsibleState = this.allCollapsed
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.Expanded;
    return item;
  }

  /** fork 节点 → 行集：节点自身行（+meta 副行），子会话挂进
   *  forkChildren 由 getChildren 取用——TreeView 的层级靠
   *  getChildren(element) 递归，不是拍平进父列表。父行展开默认态，
   *  fork 链整条可见才是这个模式的卖点。 */
  private forkRows(node: ForkNode): vscode.TreeItem[] {
    const rows = this.sessionRows(node.session, false);
    const head = rows[0];
    if (!node.children.length) return rows;
    const childRows = node.children.flatMap((c) => this.forkRows(c));
    this.forkChildren.set(head, childRows);
    head.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    for (const child of childRows) {
      if (child.id) this.itemIndex.set(sessionIdOf(child), { item: child, parent: head });
    }
    return rows;
  }

  private sessionItem(s: ApiSession, flat: boolean): vscode.TreeItem {
    const running = this.runningIds.has(s.id);
    const awaiting = this.awaitingIds.has(s.id);
    const pinned = this.pinnedIds.has(s.id);
    const archived = this.archivedIds.has(s.id);
    const maxCols = piConfig().get<number>("sessions.titleMaxWidth", DEFAULT_TITLE_MAX_COLS);
    const title = sessionTitle(s);
    const item = new vscode.TreeItem(
      maxCols > 0 ? truncateToCols(title, Math.max(MIN_TITLE_COLS, maxCols)) : title,
    );
    item.id = `piIde.session.${s.id}`;
    this.itemIndex.set(s.id, { item });
    const desc: string[] = [];
    if (flat && (s.projectRoot ?? s.cwd)) {
      const base = s.projectRoot ? s.projectRoot.split(/[\\/]/).pop()! : s.cwd!;
      desc.push(truncateToCols(base, 16));
    }
    desc.push(relTime(s.modified));
    if (s.messageCount) desc.push(`${s.messageCount} msgs`);
    item.description = desc.join(" · ");
    item.tooltip = sessionTooltip(s, { running, awaiting, pinned, archived });
    // 跳窗旗标按项目根判（session.cwd 可能是其子目录）——projectRoot 在
    // 本工作区外才是"异 workspace 会话"，跳窗按钮才有意义。
    const foreignDir = s.projectRoot ?? s.cwd ?? undefined;
    const foreign = !!foreignDir && workspaceRelation(foreignDir, this.workspaceRoots()) === "out";
    // 状态图标优先（running/awaiting 是活状态），否则 pinned 给图钉。
    // TreeItem 单 iconPath——pinned+running 时图钉让位，pin 仍靠排序置前。
    // flat（recent）视图没有组节点承接标记，异区会话的默认图标在此降色。
    item.iconPath = new vscode.ThemeIcon(
      running ? "pulse" : awaiting ? "bell-dot" : pinned ? "pinned" : "comment",
      running
        ? new vscode.ThemeColor("testing.iconPassed")
        : awaiting
          ? new vscode.ThemeColor("testing.iconQueued")
          : pinned
            ? new vscode.ThemeColor("textLink.foreground")
            : flat && foreign
              ? new vscode.ThemeColor("list.deemphasizedForeground")
              : undefined,
    );
    // 目录类操作的显隐旗标：hasDir=有会话目录（三个操作的前提）；
    // wsSub=目录在工作区子树内（Explorer 定位）；wsOther=目录非工作区根
    // （新窗打开）。情形1（cwd=根）只留 hasDir → 只显示终端。
    // wsForeign=项目根在区外（跳窗按钮）。两层判据不同：目录操作看 cwd，
    // 跳窗看 projectRoot。
    let wsFlags = "";
    if (s.cwd) {
      const rel = workspaceRelation(s.cwd, this.workspaceRoots());
      wsFlags = `.hasDir${rel === "sub" ? ".wsSub" : ""}${rel === "sub" || rel === "out" ? ".wsOther" : ""}`;
    }
    if (foreign) wsFlags += ".wsForeign";
    item.contextValue = `piIde.session${running ? ".running" : ""}${pinned ? ".pinned" : ""}${archived ? ".archived" : ""}${wsFlags}`;
    item.command = {
      command: "piIde.session.open",
      title: "Open session",
      arguments: [s.id, sessionTitle(s)],
    };
    return item;
  }

  // metaLayout=line：meta 挪到独立副行——空 label+description 渲成暗色
  // 续行，任何宽度必见（TreeItem 无多行节点，这是双行伪装单行）。
  // 附属行不给 id（itemIndex/reveal 不索引）、独立 contextValue
  // "piIde.meta"（避开 viewItem 正则 /piIde\.session/ 的右键菜单误配），
  // 点击沿用同一会话打开命令。
  private sessionRows(s: ApiSession, flat: boolean): vscode.TreeItem[] {
    const item = this.sessionItem(s, flat);
    if (piConfig().get<string>("sessions.metaLayout", "line") !== "line") return [item];
    const desc = typeof item.description === "string" ? item.description : "";
    if (!desc) return [item];
    // meta 放 label 位 + 透明占位图标：与会话标题同走 icon→label 管线，
    // 文字列像素级对齐（description 容器自带 ~4px 左边距，用它会偏出）。
    const meta = new vscode.TreeItem(desc);
    // resourceUri 走私有 scheme：FileDecorationProvider 把它染成 description
    // 暗色（见 sessions-feature 注册处）；显式 iconPath 优先于 resource 图标。
    meta.resourceUri = vscode.Uri.parse(`${META_ROW_SCHEME}://${s.id}`);
    if (this.metaIconUri) meta.iconPath = this.metaIconUri;
    item.description = undefined;
    meta.command = item.command;
    meta.contextValue = "piIde.meta";
    meta.tooltip = item.tooltip;
    return [item, meta];
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

/**
 * 会话条目 hover：标题 + 状态徽标 + 命名会话的首消息预览 + 事实行
 * （cwd/项目根/分支/消息数/绝对与相对时间/会话 id）。记录数之前只在
 * description 里，hover 补齐；projectRoot≠cwd 时才单列一行（子目录会话）。
 */
function sessionTooltip(
  s: ApiSession,
  flags: { running: boolean; awaiting: boolean; pinned: boolean; archived: boolean },
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${sessionTitle(s)}**\n\n`);
  const states = [
    flags.running ? "running" : "",
    flags.awaiting ? "awaiting input" : "",
    flags.pinned ? "pinned" : "",
    flags.archived ? "archived" : "",
  ].filter(Boolean);
  if (states.length) md.appendMarkdown(`_${states.join(" · ")}_\n\n`);
  const fmt = (iso: string) => iso.slice(0, 16).replace("T", " ");
  const rows: string[] = [];
  if (s.firstMessage) {
    const preview = s.firstMessage.replace(/\s+/g, " ").trim();
    rows.push(`**first message** ${preview.length > 140 ? `${preview.slice(0, 140)}…` : preview}`);
  }
  if (s.cwd) rows.push(`**cwd** \`${s.cwd}\``);
  if (s.projectRoot && s.projectRoot !== s.cwd) rows.push(`**project** \`${s.projectRoot}\``);
  if (s.branch) rows.push(`**branch** \`${s.branch}\`${s.isWorktree ? " (worktree)" : ""}`);
  if (s.messageCount) rows.push(`**messages** ${s.messageCount}`);
  rows.push(`**created** ${fmt(s.created)}`);
  rows.push(`**modified** ${fmt(s.modified)} (${relTime(s.modified)})`);
  rows.push(`**id** \`${s.id}\``);
  md.appendMarkdown(rows.join("\n\n"));
  return md;
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

  const setMetaLayout = async (v: "line" | "inline") => {
    await piConfig().update("sessions.metaLayout", v, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("setContext", "piIde.sessions.metaLayout", v);
    provider.refreshView();
  };
  const setAllCollapsed = async (collapsed: boolean) => {
    provider.setAllCollapsed(collapsed);
    await vscode.commands.executeCommand("setContext", "piIde.sessions.allCollapsed", provider.isAllCollapsed());
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
    vscode.commands.registerCommand("piIde.session.copyTitle", async (item: vscode.TreeItem) => {
      const s = provider.sessionById(sessionIdOf(item));
      if (s) await vscode.env.clipboard.writeText(sessionTitle(s));
    }),
    vscode.commands.registerCommand("piIde.session.copyWorkspacePath", async (item: vscode.TreeItem) => {
      const dir = provider.sessionDir(sessionIdOf(item));
      if (dir) await vscode.env.clipboard.writeText(dir);
    }),
    vscode.commands.registerCommand("piIde.project.copyWorkspacePath", async (item: ProjectItem) => {
      if (item.group.root) await vscode.env.clipboard.writeText(item.group.root);
    }),

    // ── 跨窗路由：异 workspace 会话/项目跳对应窗口。"已开则聚焦否则
    // 新开"只有 CLI 上下文有（命令 API 固定走 API 上下文=复用当前窗），
    // 所以直接 spawn 同目录 bin/<uriScheme>.cmd——dedup+前台聚焦全由
    // VS Code 单实例 IPC 完成；脚本不在（罕见布局）才退化 forceNewWindow。
    // 会话版先写 pending-open 记录，目标窗消费后自动开会话。
    vscode.commands.registerCommand("piIde.session.openInWorkspaceWindow", async (item: vscode.TreeItem) => {
      const s = provider.sessionById(sessionIdOf(item));
      const dir = s?.projectRoot ?? s?.cwd ?? undefined;
      if (!s || !dir) return;
      writePendingOpen(dir, s.id);
      openDirInWindow(dir);
    }),
    vscode.commands.registerCommand("piIde.project.openInWindow", (item: ProjectItem) => {
      const dir = item.group.root;
      if (dir) openDirInWindow(dir);
    }),

    vscode.commands.registerCommand("piIde.sessions.refresh", () => provider.reload()),

    // 纯视图项配置即改即生效：改标题截断宽度/meta 布局只重铺，不拉清单。
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration(`${CONFIG_SECTION}.sessions.titleMaxWidth`)
        || e.affectsConfiguration(`${CONFIG_SECTION}.sessions.metaLayout`)
      ) provider.refreshView();
    }),
    // 两个命令图标化同一个开关：过滤态显示 $(list-filter)，全部态显示 $(globe)。
    vscode.commands.registerCommand("piIde.sessions.filterWorkspace", async () => {
      await provider.setWorkspaceOnly(true);
      await vscode.commands.executeCommand("setContext", "piIde.sessions.workspaceOnly", true);
    }),
    vscode.commands.registerCommand("piIde.sessions.showAll", async () => {
      await provider.setWorkspaceOnly(false);
      await vscode.commands.executeCommand("setContext", "piIde.sessions.workspaceOnly", false);
    }),
    vscode.commands.registerCommand("piIde.sessions.cycleViewMode", async () => {
      await provider.cycleViewMode();
      await vscode.commands.executeCommand("setContext", "piIde.sessions.viewMode", provider.viewMode);
    }),

    // metaLayout 单双行切换：写全局配置即持久，配置监听器顺带重铺；
    // context 键驱动按钮的显隐对。
    vscode.commands.registerCommand("piIde.sessions.metaInline", () => setMetaLayout("inline")),
    vscode.commands.registerCommand("piIde.sessions.metaLine", () => setMetaLayout("line")),

    // 折叠双态：代际 id 法（见 provider.setAllCollapsed）。
    vscode.commands.registerCommand("piIde.sessions.collapseAll", () => setAllCollapsed(true)),
    vscode.commands.registerCommand("piIde.sessions.expandAll", () => setAllCollapsed(false)),
  );
}

/**
 * 跳对应 workspace 的窗口：优先 spawn 本 IDE 的 CLI 脚本——CLI 上下文
 * 自带"已开同目录窗则聚焦、否则新开"语义（命令 API 拿不到）。脚本与
 * 主 exe 同目录 bin/ 下，文件名 = env.uriScheme（vscodium→codium.cmd）。
 * 找不到脚本退化 openFolder forceNewWindow——功能仍对，只是可能多开窗。
 * CLI 往返 ~3-5s 属正常（单实例 IPC 握手），detached 不等返回。
 */
function openDirInWindow(dir: string): void {
  const scheme = vscode.env.uriScheme; // vscode→code, vscodium→codium, code-insiders→code-insiders
  const exeDir = path.dirname(process.execPath);
  const candidates =
    process.platform === "win32"
      ? [path.join(exeDir, "bin", `${scheme}.cmd`)]
      : process.platform === "darwin"
        ? [path.join(exeDir, "..", "Resources", "app", "bin", scheme)]
        : [path.join(exeDir, "bin", scheme), path.join("/usr", "bin", scheme)];
  const cli = candidates.find((c) => fs.existsSync(c));
  if (cli) {
    logLifecycle(`open in workspace window: CLI ${cli} ${dir}`);
    cp.spawn(cli, [dir], {
      shell: process.platform === "win32", // .cmd 必须经 cmd.exe
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    return;
  }
  logLifecycle(`open in workspace window: CLI not found (${exeDir}) → openFolder forceNewWindow ${dir}`);
  void vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(dir), { forceNewWindow: true });
}

import { sessionIdOf } from "./session-id";
import { writePendingOpen } from "./pending-open";
