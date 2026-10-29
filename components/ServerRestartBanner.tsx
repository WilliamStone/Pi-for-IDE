"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { SERVER_RESTARTED_EVENT } from "@/lib/boot-watch";

// Top-center notice once the serving process changed under this page: the old
// build is still in memory, so the page must reload instead of silently mixing
// builds. Covers standalone and browser tabs (embed hosts swap the iframe URL
// themselves). Reload is automatic after a short beat — the draft store
// mirrors every keystroke into localStorage synchronously, so nothing
// committed is lost, and the banner doubles as the "why did the page blink"
// notice. The button remains for impatient users; detection itself only
// fires on a healthy /api/agent/running response, so the reload always
// lands on the new (already-up) server.
const AUTO_RELOAD_MS = 1500;

export function ServerRestartBanner() {
  const { t } = useI18n();
  const [restarted, setRestarted] = useState(false);

  useEffect(() => {
    const onRestart = () => setRestarted(true);
    window.addEventListener(SERVER_RESTARTED_EVENT, onRestart);
    return () => window.removeEventListener(SERVER_RESTARTED_EVENT, onRestart);
  }, []);

  useEffect(() => {
    if (!restarted) return;
    const timer = setTimeout(() => window.location.reload(), AUTO_RELOAD_MS);
    return () => clearTimeout(timer);
  }, [restarted]);

  if (!restarted) return null;
  return (
    <div
      role="status"
      style={{
        position: "fixed",
        top: 8,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg)",
        boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
        color: "var(--text)",
        fontSize: 12,
      }}
    >
      <span>{t("system.serverRestarted")}</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{
          border: "none",
          borderRadius: 6,
          padding: "4px 10px",
          background: "var(--accent)",
          color: "var(--bg)",
          fontSize: 12,
          fontWeight: 650,
          cursor: "pointer",
        }}
      >
        {t("system.reload")}
      </button>
    </div>
  );
}
