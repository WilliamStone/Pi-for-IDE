// 升级提示去重（会话级）：同一个可升级动作只向用户弹一次框。
// 三条独立路径会就同一事实打扰用户——
//   1) resolve 时的"已解析副本比本地包旧"警告（server-resolve.ts）
//   2) 激活 +8s 的后台升级检查（extension.ts）
//   3) 手动 Upgrade 命令（extension.ts，显式触发、永远弹但留下标记）
// 共享这个标记后，先触达的路径留下签名，后续路径只写报告不再弹框。

let surfaced: string | undefined;

/** 记录刚向用户弹过的升级动作签名。 */
export function markUpgradeSurfaced(sig: string): void {
  surfaced = sig;
}

/** 该动作本会话内是否已弹过提示。 */
export function wasUpgradeSurfaced(sig: string): boolean {
  return surfaced === sig;
}
