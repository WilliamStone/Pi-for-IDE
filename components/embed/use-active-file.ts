"use client";

import { useEffect, useState } from "react";
import { isEmbedMode, getActiveEditorViaHost, onEmbedHostNotification } from "@/lib/embed/bridge";

export interface ActiveFile {
  /** 相对宿主工作区根目录的路径；无活动文件时为 null。 */
  relativePath: string | null;
  /** 绝对路径。 */
  filePath: string | null;
}

/**
 * 宿主当前活动编辑器文件。embed 模式下主动拉取一次初始状态，并监听宿主
 * 推送的 activeEditorChanged 通知；非 embed 模式恒为 null。
 */
export function useActiveFile(): ActiveFile | null {
  const [activeFile, setActiveFile] = useState<ActiveFile | null>(null);

  useEffect(() => {
    if (!isEmbedMode()) return;
    let cancelled = false;
    void getActiveEditorViaHost().then((active) => {
      if (!cancelled) setActiveFile(active);
    }).catch(() => {
      if (!cancelled) setActiveFile({ relativePath: null, filePath: null });
    });
    const unsubscribe = onEmbedHostNotification((payload) => {
      if (payload.kind !== "activeEditorChanged") return;
      setActiveFile({
        relativePath: (payload as { relativePath?: string | null }).relativePath ?? null,
        filePath: (payload as { filePath?: string | null }).filePath ?? null,
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return activeFile;
}
