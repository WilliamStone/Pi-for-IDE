"use client";

import { useCallback, type KeyboardEvent } from "react";
import { isEmbedMode, clipboardReadViaHost, clipboardWriteViaHost } from "@/lib/embed/bridge";

/**
 * embed 模式下跨源 iframe 的 Cmd/Ctrl+C/V/X/A 默认行为可能被宿主的
 * 命令层拦截，到不了 textarea。返回的 keydown 处理器在输入框的
 * onKeyDown 最前面同步截住这些键：preventDefault 后用宿主剪贴板桥读写
 * 系统剪贴板 + 手动操作 textarea 选区，绕过拦截。
 *
 * 返回 false 表示未处理该键，交给后续处理器。
 */
export function useEmbedClipboardKeys(opts: {
  value: string;
  setValue: (v: string) => void;
  isComposingRef: { current: boolean };
}): (e: KeyboardEvent<HTMLTextAreaElement>) => boolean {
  const { value, setValue, isComposingRef } = opts;
  const embedMode = isEmbedMode();
  return useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!embedMode) return false;
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return false;
      const k = e.key.toLowerCase();
      if (k !== "c" && k !== "v" && k !== "x" && k !== "a") return false;
      const ta = e.currentTarget;
      // 输入法组合中不拦截，避免打断中文输入。
      if (isComposingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return false;

      // 同步截住：不让宿主命令层拿走这个键。
      e.preventDefault();
      e.stopPropagation();

      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const selected = start !== null && end !== null ? value.slice(start, end) : "";

      if (k === "a") {
        ta.select();
        return true;
      }

      // 复制 / 剪切：写选中文本到系统剪贴板，剪切还要删选中。
      if (k === "c" || k === "x") {
        if (selected) {
          void clipboardWriteViaHost(selected).catch(() => {
            try { void navigator.clipboard?.writeText(selected); } catch { /* ignore */ }
          });
          if (k === "x") {
            const next = value.slice(0, start!) + value.slice(end!);
            setValue(next);
            requestAnimationFrame(() => {
              ta.selectionStart = ta.selectionEnd = start!;
            });
          }
        }
        return true;
      }

      // 粘贴：从系统剪贴板读文本插入。fire-and-forget，preventDefault 已同步拦住默认行为。
      void (async () => {
        let text = "";
        try {
          text = await clipboardReadViaHost();
        } catch {
          try { text = await navigator.clipboard?.readText() ?? ""; } catch { /* ignore */ }
        }
        if (!text) return;
        const s = start ?? value.length;
        const en = end ?? value.length;
        const next = value.slice(0, s) + text + value.slice(en);
        setValue(next);
        const caret = s + text.length;
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = caret;
          ta.style.height = "auto";
          ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
        });
      })();
      return true;
    },
    [embedMode, value, setValue, isComposingRef],
  );
}
