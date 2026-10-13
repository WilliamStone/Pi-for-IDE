"use client";

import { useI18n } from "@/hooks/useI18n";

/**
 * embed 模式下输入框下方的「宿主当前打开文件」提示条。
 * 由 ChatInput 在 `activeFile && !bashMode` 时挂载。
 */
export function ActiveFileHint({ path }: { path: string }) {
  const { t } = useI18n();
  return (
    <div
      title={t("chat.activeFileTitle")}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        marginTop: 6, padding: "3px 10px",
        background: "var(--bg-subtle)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        fontSize: 11,
        color: "var(--text-dim)",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      }}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <span style={{ flexShrink: 0, opacity: 0.8 }}>{t("chat.activeFileLabel")}</span>
      <span style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis" }}>{path}</span>
    </div>
  );
}
