"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";

/**
 * 用户消息左侧的「回退此轮」按钮（hover 显示，固定宽度占位避免布局跳动）。
 * 点击后先二次确认，确认后调 onRevert 执行回退。
 */
export function TurnRevertButton({
  entryId,
  reverting,
  onRevert,
  hovered,
}: {
  entryId: string;
  reverting?: boolean;
  onRevert: (entryId: string) => void;
  hovered: boolean;
}) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);

  return (
    <div style={{
      width: 72, flexShrink: 0,
      display: "flex", flexDirection: "column", alignItems: "flex-start",
      gap: 4, paddingBottom: 2,
    }}>
      {confirming ? (
        <>
          <span style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
            {t("chat.revertConfirm")}
          </span>
          <span style={{ display: "flex", gap: 4 }}>
            <button
              onClick={() => {
                setConfirming(false);
                onRevert(entryId);
              }}
              disabled={reverting}
              title={t("chat.revertConfirmYes")}
              style={{
                padding: "2px 7px", height: 20,
                background: "var(--accent)", border: "none",
                borderRadius: 4, color: "#fff",
                cursor: reverting ? "not-allowed" : "pointer",
                fontSize: 10, fontWeight: 500, whiteSpace: "nowrap",
              }}
            >{t("chat.revertConfirmYes")}</button>
            <button
              onClick={() => setConfirming(false)}
              disabled={reverting}
              title={t("chat.revertConfirmNo")}
              style={{
                padding: "2px 7px", height: 20,
                background: "none", border: "1px solid var(--border)",
                borderRadius: 4, color: "var(--text-muted)",
                cursor: "pointer", fontSize: 10, whiteSpace: "nowrap",
              }}
            >{t("chat.revertConfirmNo")}</button>
          </span>
        </>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          title={t("chat.revertTurnTitle")}
          style={{
            display: "flex", alignItems: "center", gap: 4,
            padding: "3px 8px", height: 22,
            background: "none", border: "none",
            borderRadius: 5,
            color: "var(--text-dim)",
            cursor: "pointer", fontSize: 11, fontWeight: 400,
            whiteSpace: "nowrap",
            opacity: hovered ? 1 : 0,
            transition: "opacity 0.12s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 14 4 9 9 4" />
            <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
          </svg>
          {t("chat.revertTurn")}
        </button>
      )}
    </div>
  );
}
