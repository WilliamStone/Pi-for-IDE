"use client";

import { memo, useState, useCallback, useMemo } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getFileIcon } from "../FileIcons";
import { SplitPatchView, PatchTextView } from "../MessageView";
import { isEmbedMode, showDiffViaHost, getBeforeContentViaHost } from "@/lib/embed/bridge";
import { encodeFilePathForApi } from "@/lib/file-paths";
import type { FileChange } from "@/lib/file-changes";

interface Props {
  /** 本轮 turn 的标识（user message 的 entryId）。 */
  turnId: string;
  /** 本轮改动的文件列表。 */
  changes: FileChange[];
  /** session 工作目录（绝对路径）。 */
  cwd?: string;
  /** 打开文件查看器（Web 模式点击文件时调用）。 */
  onOpenFile?: (filePath: string) => void;
}

/**
 * 文件审查卡片：在一轮对话的 final answer 下方展示本轮改动的文件列表。
 *
 * diff 策略（纯前端，零 git / 零快照依赖）：
 *   - edit：result.details.diff 已是完整 unified diff（含 before/after 行），
 *           直接用 SplitPatchView inline 渲染。这是最常见情况，100% 准确。
 *   - write：input.content 是完整新内容（after），before 为空（新建文件），
 *            渲染为「全增」行。
 *   - bash：无具体文件，显示提示行。
 *
 * 回退入口不在本卡片——在用户消息左侧（MessageView.UserMessageView），
 * 回退 = 恢复代码 + 删除该轮会话记录。
 */
function FileReviewCardImpl({ turnId, changes, cwd, onOpenFile }: Props) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const [openDiffPath, setOpenDiffPath] = useState<string | null>(null);

  const hasFiles = changes.some((c) => c.path);
  const hasBashUntracked = changes.some((c) => c.kind === "bash" && !c.path);

  const fileChanges = changes.filter((c) => c.path);
  const fileCount = fileChanges.length;
  const inEmbed = isEmbedMode();

  // 点击文件行：inline 展开/收起 diff 视图（纯前端）
  const handleFileClick = useCallback((change: FileChange) => {
    if (!change.path) return;
    setOpenDiffPath((cur) => (cur === change.path ? null : change.path));
  }, []);

  // embed 模式：在宿主编辑器里用原生 diff 打开（需 before 快照）
  const handleOpenInEditor = useCallback(async (change: FileChange, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!inEmbed || !cwd) return;
    let before = "";
    let after = "";
    if (change.kind === "edit") {
      try {
        const resp = await fetch(`/api/files/${encodeFilePathForApi(change.path)}?type=read`);
        if (resp.ok) {
          const data = await resp.json() as { content?: string };
          after = data.content ?? "";
        }
      } catch {}
      before = (await getBeforeContentViaHost(turnId, change.path, cwd)) ?? "";
    } else if (change.kind === "write") {
      after = change.newContent ?? "";
      before = (await getBeforeContentViaHost(turnId, change.path, cwd)) ?? "";
    } else {
      return;
    }
    await showDiffViaHost(change.path, before, after, `${change.relativePath} (本轮改动)`);
  }, [inEmbed, turnId, cwd]);

  // Web 模式：点击「在文件查看器打开」按钮
  const handleOpenInViewer = useCallback((change: FileChange, e: React.MouseEvent) => {
    e.stopPropagation();
    onOpenFile?.(change.path);
  }, [onOpenFile]);

  if (!hasFiles && !hasBashUntracked) return null;

  return (
    <div style={{
      marginTop: 10,
      marginBottom: 14,
      borderRadius: 7,
      border: "1px solid var(--border)",
      background: "var(--bg-panel)",
      overflow: "hidden",
      fontSize: 12,
    }}>
      {/* 头部 */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 10px",
        cursor: "pointer",
        userSelect: "none",
      }} onClick={() => setExpanded((v) => !v)}>
        <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}>
          <polyline points="3 2.5 6.5 5 3 7.5" />
        </svg>
        <span style={{ color: "var(--text-muted)", fontWeight: 600, flexShrink: 0 }}>
          📋 {t("chat.fileReview")}
        </span>
        {fileCount > 0 ? (
          <span style={{ color: "var(--text-dim)" }}>{t("chat.fileReviewCount", { count: fileCount })}</span>
        ) : (
          <span style={{ color: "var(--text-dim)" }}>{t("chat.fileReviewEmpty")}</span>
        )}
        <div style={{ flex: 1 }} />
      </div>

      {/* 文件列表 */}
      {expanded && (
        <div style={{ borderTop: "1px solid var(--border)" }}>
          {fileChanges.map((change, i) => (
            <FileReviewRow
              key={`${change.path}-${i}`}
              change={change}
              isOpen={openDiffPath === change.path}
              onClick={() => handleFileClick(change)}
              onOpenInEditor={inEmbed ? (e) => void handleOpenInEditor(change, e) : undefined}
              onOpenInViewer={!inEmbed ? (e) => handleOpenInViewer(change, e) : undefined}
            />
          ))}
          {hasBashUntracked && (
            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "6px 12px",
              color: "var(--text-dim)", fontSize: 11, fontStyle: "italic",
              borderTop: fileChanges.length > 0 ? "1px solid var(--border)" : "none",
            }}>
              <span>⚠</span>
              <span>{t("chat.fileReviewBashUntracked")}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const FileReviewRow = memo(function FileReviewRow({
  change,
  isOpen,
  onClick,
  onOpenInEditor,
  onOpenInViewer,
}: {
  change: FileChange;
  isOpen: boolean;
  onClick: () => void;
  onOpenInEditor?: (e: React.MouseEvent) => void;
  onOpenInViewer?: (e: React.MouseEvent) => void;
}) {
  const iconName = getFileIcon(change.relativePath || change.path, 13);
  const kindLabel = change.kind === "edit" ? "edit"
    : change.kind === "write" ? "write"
    : change.kind;
  const kindColor = change.kind === "write" ? "#3b82f6" : "#16a34a";

  return (
    <div style={{ borderTop: "1px solid var(--border)" }}>
      <button
        onClick={onClick}
        title={change.path}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          width: "100%", padding: "6px 12px",
          background: "none", border: "none", cursor: "pointer",
          color: "var(--text-muted)", fontSize: 12,
          textAlign: "left", minWidth: 0,
          transition: "background 0.1s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
      >
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}>
          <polyline points="3 2.5 6.5 5 3 7.5" />
        </svg>
        <span style={{ fontSize: 13, flexShrink: 0, display: "flex", alignItems: "center" }}>{iconName}</span>
        <span style={{
          fontFamily: "var(--font-mono)", fontSize: 11,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          flex: 1, minWidth: 0,
        }}>
          {change.relativePath || change.path}
        </span>
        <span style={{
          fontFamily: "var(--font-mono)", fontSize: 10, color: kindColor,
          flexShrink: 0, padding: "1px 5px", borderRadius: 3,
          background: `${kindColor}1a`,
        }}>
          {kindLabel}
        </span>
        {onOpenInEditor && (
          <span
            role="button"
            onClick={onOpenInEditor}
            title="在编辑器 diff 中打开"
            style={{
              flexShrink: 0, fontSize: 10, color: "var(--accent)",
              padding: "1px 5px", borderRadius: 3,
              border: "1px solid var(--border)", cursor: "pointer",
            }}
          >↗</span>
        )}
        {onOpenInViewer && (
          <span
            role="button"
            onClick={onOpenInViewer}
            title="在文件查看器打开"
            style={{
              flexShrink: 0, fontSize: 10, color: "var(--accent)",
              padding: "1px 5px", borderRadius: 3,
              border: "1px solid var(--border)", cursor: "pointer",
            }}
          >↗</span>
        )}
      </button>
      {isOpen && (
        <div style={{
          borderTop: "1px solid var(--border)",
          maxHeight: 400, overflowY: "auto",
          background: "var(--bg)",
        }}>
          <DiffContentView change={change} />
        </div>
      )}
    </div>
  );
});

/**
 * inline diff 内容视图。
 * - edit 有 diffText → SplitPatchView 渲染统一 diff（最准确，自带 before/after）
 * - write 有 newContent → 渲染为「全增」伪 diff（before 空，after = content）
 * - 都没有 → PatchTextView 兜底显示原始文本
 */
function DiffContentView({ change }: { change: FileChange }) {
  const { t } = useI18n();

  const writeDiffText = useMemo(() => {
    if (change.kind !== "write") return null;
    const content = change.newContent ?? "";
    if (!content) return null;
    // 构造一个「全增」的伪 unified diff，让 SplitPatchView 渲染成右侧全绿
    const lines = content.split("\n");
    const body = lines.map((l, i) => `+${i + 1} ${l}`).join("\n");
    return `--- /dev/null\n+++ ${change.relativePath || change.path}\n@@ -0,0 +1,${lines.length} @@\n${body}`;
  }, [change]);

  if (change.kind === "edit" && change.diffText) {
    return <SplitPatchView text={change.diffText} />;
  }
  if (change.kind === "write" && writeDiffText) {
    return <SplitPatchView text={writeDiffText} />;
  }
  if (change.kind === "edit") {
    return (
      <div style={{ padding: "8px 12px", color: "var(--text-dim)", fontSize: 11 }}>
        {t("chat.fileReviewNoDiff")}
      </div>
    );
  }
  return <PatchTextView text={change.newContent ?? ""} />;
}

export const FileReviewCard = memo(FileReviewCardImpl);
