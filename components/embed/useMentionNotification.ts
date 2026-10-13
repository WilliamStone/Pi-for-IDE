"use client";

import { useEffect } from "react";
import { isEmbedMode, onEmbedHostNotification } from "@/lib/embed/bridge";
import { buildAtMentionText, buildFileLineMentionText } from "@/lib/file-fuzzy";
import type { ChatInputHandle } from "../ChatInput";

/**
 * embed 模式：监听宿主推送的「提及」通知（如宿主右键菜单触发）。
 * 仅向聊天输入框插入 @path 或 @path:start-end 行范围提及，不插入代码块。
 */
export function useMentionNotification(
  chatInputRef: { current: ChatInputHandle | null } | undefined,
): void {
  useEffect(() => {
    if (!isEmbedMode() || !chatInputRef) return;
    const unsubscribe = onEmbedHostNotification((msg) => {
      if (msg.kind !== "mention") return;
      const p = msg.relativePath as string;
      const start = msg.startLine as number | undefined;
      const end = msg.endLine as number | undefined;
      if (start != null && end != null) {
        chatInputRef.current?.insertText(buildFileLineMentionText(p, start, end));
      } else {
        chatInputRef.current?.insertText(buildAtMentionText(p, false));
      }
    });
    return unsubscribe;
  }, [chatInputRef]);
}
