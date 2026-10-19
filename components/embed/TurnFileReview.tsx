"use client";

import { extractFileChanges } from "@/lib/file-changes";
import type { TurnSnapshotTracker } from "@/lib/embed/turn-snapshot";
import type { AgentMessage } from "@/lib/types";
import { FileReviewCard } from "./FileReviewCard";

/**
 * 一轮对话后的文件审查卡片区（embed 模式）。
 * 对一轮 messages 提取文件改动；无改动时渲染 null。
 */
export function TurnFileReview({
  turnMessages,
  userEntryId,
  turnIdx,
  cwd,
  sessionId,
  turnSnapshots,
  onOpenFile,
}: {
  turnMessages: AgentMessage[];
  /** 该轮 user message 的 entryId；用于反查快照 turnId。 */
  userEntryId: string | undefined;
  /** 无 entryId 时的兜底 turnId 后缀。 */
  turnIdx: number;
  cwd: string | undefined;
  /** 会话 id——/api/files 的 allowedRoots 按 session 引用放行 cwd 外文件需要它。 */
  sessionId?: string;
  turnSnapshots: TurnSnapshotTracker;
  onOpenFile?: (filePath: string) => void;
}) {
  const turnChanges = extractFileChanges(turnMessages, cwd);
  const turnId = userEntryId
    ? turnSnapshots.turnIdForEntry(userEntryId)
    : `turn-${turnIdx}`;
  if (turnChanges.length === 0) return null;
  return (
    <FileReviewCard
      turnId={turnId}
      changes={turnChanges}
      cwd={cwd}
      sessionId={sessionId}
      onOpenFile={onOpenFile}
    />
  );
}
