"use client";

import { useEffect } from "react";
import { isEmbedMode, sendEmbedRequest } from "@/lib/embed/bridge";
import type { AtQueryMatch, FileIndexEntry } from "@/lib/file-fuzzy";

export interface AtServerResult {
  cwd: string;
  query: string;
  matches: FileIndexEntry[];
}

/**
 * Embed mode: when the @ token is active, ask the embed host for file
 * completions. The host ranks against its own file index (workspace
 * + open editors) which is always current. Results replace local matches
 * while the token is open; closing the token clears them.
 *
 * 非 embed 模式为空操作；宿主补全结果写入调用方的 atServerResult 状态，
 * 由调用方决定如何与本地索引结果合并。
 */
export function useEmbedAtCompletion(opts: {
  cwd: string | null | undefined;
  atQuery: AtQueryMatch | null;
  atQueryText: string | null;
  atServerResult: AtServerResult | null;
  setAtServerResult: (r: AtServerResult | null) => void;
}): void {
  const { cwd, atQuery, atQueryText, atServerResult, setAtServerResult } = opts;
  const embedMode = isEmbedMode();

  useEffect(() => {
    const tokenActive = atQuery !== null;
    if (!embedMode || !tokenActive || !cwd || atQueryText === null) {
      if (embedMode && atServerResult !== null) setAtServerResult(null);
      return;
    }
    const fetchCwd = cwd;
    const query = atQueryText;
    let cancelled = false;
    const timer = setTimeout(() => {
      sendEmbedRequest<{ matches?: Array<{ path: string; isDir: boolean }> }>(
        { kind: "completeAt", cwd: fetchCwd, query },
        4000,
      )
        .then((res) => {
          if (cancelled) return;
          const matches: FileIndexEntry[] = (res?.matches ?? []).map((m) => ({
            path: m.path,
            name: m.path.split("/").pop() ?? m.path,
            isDir: m.isDir,
          }));
          setAtServerResult({ cwd: fetchCwd, query, matches });
        })
        .catch((err) => {
          if (cancelled) return;
          // Bridge failed (timeout / no workspace) — surface an empty result so
          // the menu doesn't keep showing stale local matches.
          console.warn("[pi-web] @-complete bridge failed:", err);
          setAtServerResult({ cwd: fetchCwd, query, matches: [] });
        });
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
    // NOTE: atServerResult is intentionally excluded from deps — including it
    // would cause an infinite loop: response → setAtServerResult → effect
    // re-runs → sends another request → response → …
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedMode, atQuery, atQueryText, cwd]);
}
