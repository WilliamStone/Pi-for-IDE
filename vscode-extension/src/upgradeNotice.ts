import { formatBuildStamp } from "./version";

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

/**
 * 动作 → 签名字符串。结构型参数（不依赖 server-resolve 的类型，
 * 避免循环导入）——三个调用方（resolve 警告/auto 检查/手动命令）
 * 对同一计划必须产出同一签名，漏一个字段就是一次重复打扰。
 */
export function upgradeActionSig(a: {
  kind: "local" | "registry" | "none";
  label?: string;
  version?: string;
  reason?: string;
}): string {
  return a.kind === "local"
    ? `local:${a.label}`
    : a.kind === "registry"
      ? `registry:${a.version}`
      : `none:${a.reason}`;
}

/** 本地候选 → `local:` 签名（resolve 警告路径与 plan 的 a.label 同口径）。 */
export function localUpgradeSig(c: { version: string; builtAt?: string; gitSha?: string }): string {
  return `local:${c.version}${formatBuildStamp(c.builtAt)}${c.gitSha ? ` (${c.gitSha})` : ""}`;
}
