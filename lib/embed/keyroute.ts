// 嵌入页热键兜底转发：页面没消费的组合键原样发回 shell——shell 在自身
// 文档上合成等量 keydown，由 VS Code 注入 webview 的内置监听器转给
// workbench 快捷键系统做原生解析（用户自定义绑定/when 子句全生效）。
// 跨源 iframe 让按键天然出不去，只能靠页面主动投递。

import { isEmbedMode, notifyEmbedHost } from "./bridge.ts";
import { initEmbedDiagnostics } from "./watchdog.ts";

/** 值得转发的按键：带任一修饰键，或 F1–F12。裸字母/数字/方向键留页面。 */
export function shouldForward(e: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  defaultPrevented: boolean;
  isComposing?: boolean;
}): boolean {
  if (e.defaultPrevented || e.isComposing) return false; // 页面已消费 / IME 组词中
  // 纯修饰键按下本身不构成热键。
  if (["Control", "Shift", "Alt", "Meta", "OS"].includes(e.key)) return false;
  if (e.ctrlKey || e.altKey || e.metaKey) return true;
  return /^F\d{1,2}$/.test(e.key);
}

let installed = false;

/**
 * 挂一次性的兜底 keydown 监听（bubble 阶段——跑在页面 handler 之后，
 * defaultPrevented 能可靠反映"页面消费了没"）。embed 模式外为空操作。
 */
export function initEmbedKeyRouter(): void {
  if (installed || typeof window === "undefined" || !isEmbedMode()) return;
  installed = true;
  window.addEventListener("keydown", (e) => {
    if (!shouldForward(e)) return;
    notifyEmbedHost({
      kind: "keyPassthrough",
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      repeat: e.repeat,
    });
  });
  // 空视图看门狗等页面诊断——同一次 init 顺带挂上，embed 外与
  // 非会话页各自短路（见 watchdog.ts）。
  initEmbedDiagnostics();
}
