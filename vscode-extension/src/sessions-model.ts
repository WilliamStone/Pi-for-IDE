import { baseName, isWithinCwd, pathKey, sameDir } from "./paths";

/**
 * 原生会话侧栏的纯数据模型——无 vscode 依赖，node:test 可直接测。
 * 数据面与 pi-web 侧栏一致：projectRoot 分组、modified 排序；嵌套项目
 * 天然成立（cwd 是仓库子目录时 projectRoot=cwd，各成一组）。
 */

export interface ApiSession {
  id: string;
  name?: string | null;
  firstMessage?: string | null;
  cwd?: string | null;
  projectRoot?: string | null;
  branch?: string | null;
  isWorktree?: boolean;
  /** 服务端算好的项目身份键（win32 大小写折叠、分隔符归一）——分组键
   *  用它而非 projectRoot 原文，否则 s:\x 与 S:\x 拆成两个项目组。 */
  projectKey?: string | null;
  /** fork/衍生会话的父会话 id（父文件不在清单里时缺省 → 作根显示）。 */
  parentSessionId?: string | null;
  /** subagent 会话挂在父会话下，不进侧栏顶层列表。 */
  relation?: { kind: string; originSessionId?: string } | null;
  created: string;
  modified: string;
  messageCount?: number;
}

export interface ProjectGroup {
  /** projectRoot ?? cwd——服务端 projectIdentityKey 的等价口径。 */
  key: string;
  root: string;
  label: string;
  branch?: string;
  isWorktree: boolean;
  sessions: ApiSession[];
}

export type SessionsViewMode = "byProject" | "recent" | "fork";

/** fork 树节点：会话 + 它的直接 fork 子会话。 */
export interface ForkNode {
  session: ApiSession;
  children: ForkNode[];
}

/**
 * fork 关系森林：parentSessionId 指向清单内会话的挂其下，父会话缺失
 * （被删/被工作区过滤滤掉/人工移动文件）的 fork 作根显示——宁可平铺
 * 也不丢行。沿用入参顺序（调用方已按 modified 降序排好）。
 */
export function forkForest(sessions: ApiSession[]): ForkNode[] {
  const ids = new Set(sessions.map((s) => s.id));
  const byParent = new Map<string, ApiSession[]>();
  const roots: ApiSession[] = [];
  for (const s of sessions) {
    const p = s.parentSessionId ?? (s.relation?.kind === "fork" ? s.relation.originSessionId : undefined);
    if (p && ids.has(p)) {
      const kids = byParent.get(p);
      if (kids) kids.push(s);
      else byParent.set(p, [s]);
    } else {
      roots.push(s);
    }
  }
  // 环防御：seen 截断防死递归；纯环（A→B→A）无根可达——补根兜底，
  // 宁可平铺也不丢行。
  const build = (s: ApiSession, seen: Set<string>): ForkNode => {
    const next = new Set(seen).add(s.id);
    const children = (byParent.get(s.id) ?? [])
      .filter((c) => !seen.has(c.id))
      .map((c) => build(c, next));
    return { session: s, children };
  };
  const forest = roots.map((s) => build(s, new Set([s.id])));
  const covered = new Set<string>();
  const mark = (n: ForkNode): void => {
    covered.add(n.session.id);
    for (const c of n.children) mark(c);
  };
  for (const n of forest) mark(n);
  for (const s of sessions) {
    if (!covered.has(s.id)) forest.push({ session: s, children: [] });
  }
  return forest;
}

/** 会话目录落在任一 workspace 根子树内（含根本身）即属于本工作区。 */
export function isInWorkspace(session: ApiSession, workspaceRoots: string[]): boolean {
  const dir = session.cwd ?? session.projectRoot;
  if (!dir) return false;
  return workspaceRoots.some((root) => isWithinCwd(dir, root));
}

/**
 * 会话目录与宿主工作区根的位置关系——会话行的目录类操作（在 Explorer
 * 中定位 / 新窗打开 / 打开终端）按它显隐。无目录返回 null。
 */
export type WorkspaceRelation = "same" | "sub" | "out";
export function workspaceRelation(
  dir: string | null | undefined,
  workspaceRoots: string[],
): WorkspaceRelation | null {
  if (!dir) return null;
  if (workspaceRoots.some((root) => sameDir(dir, root))) return "same";
  if (workspaceRoots.some((root) => isWithinCwd(dir, root))) return "sub";
  return "out";
}

/** 行标题：用户命名 > 首条消息单行截断 > 兜底。 */
export function sessionTitle(session: ApiSession): string {
  const named = session.name?.trim();
  if (named) return named;
  const first = session.firstMessage?.replace(/\s+/g, " ").trim();
  if (first) return first.length > 60 ? `${first.slice(0, 57)}…` : first;
  return "(untitled)";
}

/** 顶层会话过滤：subagent 会话属于其父会话，不单独成行。 */
export function topLevelSessions(sessions: ApiSession[]): ApiSession[] {
  return sessions.filter((s) => s.relation?.kind !== "subagent");
}

/** 项目分组：组序 = 组内最新 modified 降序；组内会话同序。
 *  分组键 = 服务端 projectKey（平台化身份），缺席才退化本地归一——
 *  win32 大小写折叠、POSIX 原样（Linux/macOS 路径大小写敏感，不能折）。 */
export function groupByProject(sessions: ApiSession[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const s of sessions) {
    const root = s.projectRoot ?? s.cwd ?? "";
    const key = s.projectKey ?? (root ? pathKey(root, root) : s.id);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        root,
        label: root ? baseName(root) : "(unknown)",
        branch: s.branch ?? undefined,
        isWorktree: !!s.isWorktree,
        sessions: [],
      };
      groups.set(key, g);
    }
    g.sessions.push(s);
    if (!g.branch && s.branch) g.branch = s.branch;
  }
  const out = [...groups.values()];
  for (const g of out) g.sessions.sort((a, b) => b.modified.localeCompare(a.modified));
  out.sort((a, b) => b.sessions[0].modified.localeCompare(a.sessions[0].modified));
  return out;
}

/** recent 视图：扁平列表，modified 降序，截 limit。 */
export function recentSessions(sessions: ApiSession[], limit = 50): ApiSession[] {
  return [...sessions].sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, limit);
}

/** ISO 时间 → 相对短文案（行 description 用）。 */
export function relTime(iso: string, now = Date.now()): string {
  const age = Math.max(0, now - new Date(iso).getTime());
  const m = Math.floor(age / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  if (d < 30) return `${Math.floor(d / 7)}w ago`;
  const mo = Math.floor(d / 30);
  return mo < 12 ? `${mo}mo ago` : `${Math.floor(mo / 12)}y ago`;
}

/** 视觉列宽：CJK/全角/emoji 记 2，组合附加符记 0，其余 1。TreeView 没有
 *  宽度 API，自截断要按列宽算才贴近视效——字符数会把中文名算短一半。 */
export function displayCols(text: string): number {
  let cols = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    cols += cp >= 0x300 && cp <= 0x36f ? 0 : cp >= 0x2e80 ? 2 : 1;
  }
  return cols;
}

/** 截到 maxCols 列内，超出补 "…"（占 1 列）。maxCols<=0 原样返回。 */
export function truncateToCols(text: string, maxCols: number): string {
  if (maxCols <= 0 || displayCols(text) <= maxCols) return text;
  const keep = Math.max(0, maxCols - 1);
  let cols = 0;
  let end = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const w = cp >= 0x300 && cp <= 0x36f ? 0 : cp >= 0x2e80 ? 2 : 1;
    if (cols + w > keep) break;
    cols += w;
    end += ch.length;
  }
  return `${text.slice(0, end)}…`;
}
