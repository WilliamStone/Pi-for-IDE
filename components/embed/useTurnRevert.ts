"use client";

import { useCallback, useState } from "react";
import { isEmbedMode, revertEditViaHost, revertFilesViaHost } from "@/lib/embed/bridge";
import { extractFileChanges } from "@/lib/file-changes";
import type { TurnSnapshotTracker } from "@/lib/embed/turn-snapshot";
import { useI18n } from "@/hooks/useI18n";
import type { AgentMessage } from "@/lib/types";
import type { NoticeType } from "@/hooks/useAgentSession";

export interface TurnRevertInfo {
  canRevert: boolean;
  /** 有改动但明确不可用时的原因（渲染禁用按钮 + tooltip）；否则 undefined。 */
  unavailableReason?: string;
  onRevert: (entryId: string) => void;
  reverting: boolean;
}

/**
 * 回退某一轮：恢复该轮改动的代码 + 删除该轮会话记录，然后重新加载会话。
 * 入口在用户消息左侧的回退按钮（embed/TurnRevertButton）。
 * 仅 embed 模式可用（回退依赖宿主的快照/文件写能力）。
 */
export function useTurnRevert(opts: {
  /** 当前会话 id 与 cwd（渲染期解析好的最新值）。 */
  sessionId: string | undefined;
  cwd: string | undefined;
  entryIds: string[];
  messages: AgentMessage[];
  turnSnapshots: TurnSnapshotTracker;
  sessionBusy: boolean;
  /** 判定"轮边界"的消息类型锚点（上游 ChatWindow 的 isGroupAnchor）。 */
  isTurnBoundary: (message: AgentMessage) => boolean;
  addNotice?: (notice: { id?: string; message: string; type?: NoticeType }) => void;
  loadSession: (sid: string) => Promise<unknown>;
}): {
  revertingTurnId: string | null;
  handleRevertTurn: (userEntryId: string) => Promise<void>;
  buildRevertInfo: (userIdx: number, endIdx: number) => TurnRevertInfo;
} {
  const { sessionId, cwd, entryIds, messages, turnSnapshots, sessionBusy, isTurnBoundary, addNotice, loadSession } = opts;
  const { t } = useI18n();
  const [revertingTurnId, setRevertingTurnId] = useState<string | null>(null);

  const handleRevertTurn = useCallback(async (userEntryId: string) => {
    if (revertingTurnId) return;
    const sid = sessionId;
    if (!sid || !cwd) {
      addNotice?.({ type: "error", message: t("chat.revertNoContext") });
      return;
    }
    // 找该轮：entryIds 与 messages 平行，定位用户消息索引
    const userIdx = entryIds.indexOf(userEntryId);
    if (userIdx < 0) return;
    let endIdx = userIdx + 1;
    while (endIdx < messages.length && !isTurnBoundary(messages[endIdx])) endIdx += 1;
    const turnMessages = messages.slice(userIdx, endIdx);
    const turnChanges = extractFileChanges(turnMessages, cwd);
    const turnId = turnSnapshots.turnIdForEntry(userEntryId);
    // 该轮所有 entryId（含用户消息本身）→ 删除记录
    const turnEntryIds = entryIds.slice(userIdx, endIdx).filter((e): e is string => !!e);

    setRevertingTurnId(userEntryId);
    try {
      // 1) 恢复代码（纯前端，edit 反向 apply / write 走快照）
      let okCount = 0;
      const errs: string[] = [];
      if (!isEmbedMode()) {
        throw new Error(t("chat.revertWebModeUnsupported"));
      }
      for (const change of turnChanges) {
        if (change.kind === "edit" && change.edits && change.edits.length > 0) {
          const r = await revertEditViaHost(change.path, cwd, change.edits);
          if (r.success) okCount++;
          else errs.push(`${change.relativePath}: ${r.message ?? t("chat.revertOpFailed")}`);
        } else if (change.kind === "write") {
          const r = await revertFilesViaHost(turnId, [change.path], cwd, [change.path]);
          if (r.success) okCount++;
          else errs.push(`${change.relativePath}: ${r.message ?? t("chat.revertOpFailed")}`);
        } else {
          errs.push(`${change.relativePath}: ${t("chat.revertKindUnsupported")}`);
        }
      }
      // 2) 删除该轮会话记录
      const delRes = await fetch(`/api/sessions/${encodeURIComponent(sid)}/revert-turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryIds: turnEntryIds }),
      });
      const delData = await delRes.json().catch(() => ({ error: t("chat.revertBadResponse") })) as { error?: string };
      if (!delRes.ok || delData.error) {
        errs.push(t("chat.revertDeleteFailed", { message: delData.error ?? `HTTP ${delRes.status}` }));
      }

      if (errs.length === 0) {
        addNotice?.({ type: "success", message: t("chat.revertSuccess", { count: okCount }) });
        // 3) 重新加载会话（删除记录后文件变了）
        await loadSession(sid);
      } else {
        addNotice?.({ type: "error", message: t("chat.revertFailed", { message: errs.join("; ") }) });
      }
    } catch (e) {
      addNotice?.({ type: "error", message: t("chat.revertFailed", { message: String(e) }) });
    } finally {
      setRevertingTurnId(null);
    }
  }, [revertingTurnId, sessionId, cwd, entryIds, messages, isTurnBoundary, turnSnapshots, addNotice, t, loadSession]);

  // 组装某轮的「回退」能力，用于用户消息左侧的回退按钮
  const buildRevertInfo = useCallback(
    (userIdx: number, endIdx: number): TurnRevertInfo => {
      const userEntryId = entryIds[userIdx];
      const turnChanges = extractFileChanges(messages.slice(userIdx, endIdx), cwd);
      const hasChanges = turnChanges.some((c) => c.kind === "edit" || c.kind === "write");
      // write 文件回退依赖宿主快照：本轮无 turnId 配对（reload 前或快照已
      // 淘汰）时该文件必然报错——按钮禁用而非放行失败。纯 edit 轮不需要
      // 快照（revertEdit 只靠文件当前内容与 edits）。
      const needsSnapshot = turnChanges.some((c) => c.kind === "write");
      const hasSnapshot = !!userEntryId && turnSnapshots.hasSnapshotFor(userEntryId);
      const canRevert = !!userEntryId && hasChanges && !sessionBusy;
      return {
        canRevert,
        unavailableReason: needsSnapshot && !hasSnapshot ? t("chat.revertUnavailable") : undefined,
        onRevert: canRevert && !(needsSnapshot && !hasSnapshot)
          ? (entryId: string) => void handleRevertTurn(entryId)
          : () => {},
        reverting: userEntryId === revertingTurnId,
      };
    },
    [entryIds, messages, cwd, sessionBusy, handleRevertTurn, revertingTurnId, turnSnapshots, t],
  );

  return { revertingTurnId, handleRevertTurn, buildRevertInfo };
}
