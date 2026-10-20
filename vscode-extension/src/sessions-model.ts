import { baseName, isWithinCwd } from "./paths";

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
  /** subagent 会话挂在父会话下，不进侧栏顶层列表。 */
  relation?: { kind: string } | null;
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

export type SessionsViewMode = "byProject" | "recent";

/** 会话目录落在任一 workspace 根子树内（含根本身）即属于本工作区。 */
export function isInWorkspace(session: ApiSession, workspaceRoots: string[]): boolean {
  const dir = session.cwd ?? session.projectRoot;
  if (!dir) return false;
  return workspaceRoots.some((root) => isWithinCwd(dir, root));
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

/** 项目分组：组序 = 组内最新 modified 降序；组内会话同序。 */
export function groupByProject(sessions: ApiSession[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const s of sessions) {
    const root = s.projectRoot ?? s.cwd ?? "";
    const key = root || s.id;
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
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return mo < 12 ? `${mo}mo ago` : `${Math.floor(mo / 12)}y ago`;
}
