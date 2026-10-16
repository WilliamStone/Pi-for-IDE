"use client";

import { useEffect, useRef, useState } from "react";
import { isEmbedMode } from "@/lib/embed/bridge";
import { useI18n } from "@/hooks/useI18n";

const DISMISS_KEY = "pi-web.ideHintDismissedVersion";
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";

/**
 * 独立运行模式下顶栏的 ⓘ 呼吸灯：提示 Pi Web+ 也能以 pi for IDE
 * 扩展形态嵌进 VSCode/VSCodium。点击弹小卡片；勾选"下版本前不再提示"
 * 后按版本号记入 localStorage，升级后恢复提示。
 */
export function IdeHintBadge() {
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [dontShow, setDontShow] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === APP_VERSION);
    } catch {
      setDismissed(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = () => {
      if (dontShow) {
        try {
          localStorage.setItem(DISMISS_KEY, APP_VERSION);
        } catch {
          // localStorage 不可用时仅本次会话内隐藏
        }
        setDismissed(true);
      }
      setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, dontShow]);

  if (dismissed !== false || (typeof window !== "undefined" && isEmbedMode())) return null;

  return (
    <span ref={wrapRef} style={{ position: "relative", display: "flex", alignItems: "center" }}>
      <style>{`
        @keyframes piIdeHintBreath {
          0%, 100% { opacity: 0.55; box-shadow: 0 0 0 0 rgba(88,166,255,0.35); }
          50%      { opacity: 1;    box-shadow: 0 0 0 4px rgba(88,166,255,0); }
        }
      `}</style>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t("system.ideHintTip")}
        aria-label={t("system.ideHintTip")}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          height: "100%", padding: "0 8px",
          background: "none", border: "none", cursor: "pointer",
          color: "var(--text-muted)",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
      >
        <span
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 16, height: 16, borderRadius: "50%",
            border: "1px solid currentColor",
            animation: "piIdeHintBreath 2.4s ease-in-out infinite",
            fontSize: 10, lineHeight: 1, fontStyle: "italic", fontFamily: "serif",
          }}
        >
          i
        </span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t("system.ideHintTitle")}
          style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 1000,
            width: 280, padding: "12px 14px",
            background: "var(--bg-panel)", color: "var(--text)",
            border: "1px solid var(--border)", borderRadius: 8,
            boxShadow: "0 8px 28px rgba(0,0,0,0.28)",
            fontSize: 12, lineHeight: 1.55,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{t("system.ideHintTitle")}</div>
          <div style={{ color: "var(--text-muted)" }}>{t("system.ideHintBody")}</div>
          <div style={{ marginTop: 8, fontWeight: 600, fontSize: 11 }}>{t("system.ideHintHow")}</div>
          <ul style={{ margin: "4px 0 0", paddingLeft: 16, color: "var(--text-muted)" }}>
            <li>
              <strong>VSCode / VSCodium / Cursor / Windsurf</strong>
              <div>{t("system.ideHintHowVSCode")}</div>
            </li>
          </ul>
          <label
            style={{
              display: "flex", alignItems: "center", gap: 6,
              marginTop: 10, cursor: "pointer", userSelect: "none",
              color: "var(--text-muted)",
            }}
          >
            <input
              type="checkbox"
              checked={dontShow}
              onChange={(e) => setDontShow(e.target.checked)}
            />
            {t("system.ideHintDontShow")}
          </label>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
            <button
              type="button"
              onClick={() => {
                if (dontShow) {
                  try {
                    localStorage.setItem(DISMISS_KEY, APP_VERSION);
                  } catch {}
                  setDismissed(true);
                }
                setOpen(false);
              }}
              style={{
                padding: "3px 12px", fontSize: 12, cursor: "pointer",
                background: "var(--accent, #58a6ff)", color: "#fff",
                border: "none", borderRadius: 4,
              }}
            >
              {t("common.ok")}
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
