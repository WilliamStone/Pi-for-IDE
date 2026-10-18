// 生命周期时间轴日志 + 服务器阶段状态广播——从 piIdeServer.ts 拆出的共享
// 叶子模块，port-scan/server-resolve/diagnostics 与主类共用同一频道。

import * as vscode from "vscode";

/** 统一输出频道：生命周期时间轴、spawn 日志、桥接日志都进这里——
 *  时间戳前缀天然按时间排序，单频道就能看到完整事件流。 */
let sharedChannel: vscode.OutputChannel | undefined;

export function outputChannel(): vscode.OutputChannel {
  sharedChannel ??= vscode.window.createOutputChannel("Pi for IDE");
  return sharedChannel;
}

export function logLifecycle(msg: string): void {
  const d = new Date();
  const t =
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:` +
    `${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  outputChannel().appendLine(`[${t}] ${msg}`);
}

// ---------------------------------------------------------------------------
// 服务器阶段状态广播：解析链走到哪条腿，等待页/门页实时显示"正在下载/启动"
// ——静态文案分不清这两种路径，会导致"没下载却提示在下载"的误导。
// ---------------------------------------------------------------------------
let lastServerStatus = "Starting local server…";
const statusListeners = new Set<(text: string) => void>();

/** 当前阶段文案（等待页渲染初值；之后靠 onServerStatus 推送更新）。 */
export function currentServerStatus(): string {
  return lastServerStatus;
}

/** 订阅阶段状态变化；返回退订函数。 */
export function onServerStatus(cb: (text: string) => void): () => void {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

export function emitServerStatus(text: string): void {
  lastServerStatus = text;
  logLifecycle(`stage: ${text}`);
  for (const cb of statusListeners) cb(text);
}
