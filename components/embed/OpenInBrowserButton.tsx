"use client";

import { isEmbedMode, openInBrowserViaHost } from "@/lib/embed/bridge";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";

/**
 * 「在系统浏览器中打开」顶栏按钮。
 * embed 模式下通知宿主 openExternal；独立浏览器模式下直接开新标签。
 */
export function OpenInBrowserButton() {
  const { t } = useI18n();
  const isMobile = useIsMobile();

  const onClick = () => {
    if (typeof window === "undefined") return;
    if (isEmbedMode()) {
      openInBrowserViaHost(window.location.href);
    } else {
      window.open(window.location.href, "_blank");
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title={t("system.openInBrowser")}
      aria-label={t("system.openInBrowser")}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        height: "100%", padding: "0 12px",
        background: "none",
        border: "none",
        borderTop: "2px solid transparent",
        borderRight: "1px solid var(--border)",
        cursor: "pointer",
        color: "var(--text-muted)",
        fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </svg>
      {!isMobile && <span>{t("system.openInBrowser")}</span>}
    </button>
  );
}
