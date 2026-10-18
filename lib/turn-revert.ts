/**
 * 回退一轮会话的 entry 变换——纯逻辑，抽出供路由与测试共用。
 *
 * 输入：会话文件 JSONL 解析出的 entries + 要删的 entryId 集合。
 * 输出：保留的 entries（被删 entry 的 children 重连到该轮 user 消息的
 * parentId，否则后续轮次断链）。语义边界见 docs/agents/embed-protocol.md
 * 的 "Turn revert semantics"（fork 子树会被压平进主线）。
 */

export interface SessionEntryLike {
  id?: string;
  parentId?: string | null;
  type?: string;
}

export type RevertTurnResult =
  | { ok: true; kept: SessionEntryLike[] }
  | { ok: false; error: string };

export function revertTurnEntries(
  entries: SessionEntryLike[],
  deletedIds: ReadonlySet<string>,
): RevertTurnResult {
  const deleted = new Set(deletedIds);

  // 该轮用户消息（第一个被删 entry）的 parentId → children 重连目标。
  const firstEntry = entries.find((e) => deleted.has(e.id!));
  const prevParentId = firstEntry?.parentId ?? null;

  // 不允许删 session header。
  const headerIdx = entries.findIndex((e) => e.type === "session");
  if (headerIdx >= 0 && entries[headerIdx].id && deleted.has(entries[headerIdx].id)) {
    return { ok: false, error: "Cannot delete session header" };
  }

  const kept = entries
    .filter((e) => e.id && !deleted.has(e.id))
    .map((e) => (e.parentId && deleted.has(e.parentId) ? { ...e, parentId: prevParentId } : e));

  if (kept.length === 0) {
    return { ok: false, error: "Cannot delete all entries" };
  }
  return { ok: true, kept };
}
