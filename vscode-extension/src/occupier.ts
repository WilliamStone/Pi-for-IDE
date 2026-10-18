/** 303x 端口占位者身份分类——决定诊断文案与是否可自动清理。纯模块可测。 */

export type OccupierKind = "legacy-npx" | "unscoped" | "upstream" | "ours" | "unknown";

export interface PortOccupier {
  port: number;
  pid: number;
  cmdline: string;
  kind: OccupierKind;
}

export const DEFAULT_PACKAGE = "@william_stone/pi-web-for-ide";

/** 按命令行分类占位进程：_npx 残留 / 旧 unscoped 包 / 上游 pi-web / 本扩展系。
 *  包名从配置包名推导——自定义 "Pi for IDE.package" 的实例也能归 "ours"。 */
export function classifyOccupier(cmd: string, pkgName: string = DEFAULT_PACKAGE): OccupierKind {
  if (!/pi-web|standalone\\?server\.js/i.test(cmd)) return "unknown";
  if (/_npx[\\/]/i.test(cmd)) return "legacy-npx";
  const base = (pkgName.split("/").pop() ?? "pi-web-for-ide")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(base, "i").test(cmd)) {
    // 本扩展系：scoped 全局安装（命令行含 @scope/ 目录段）或托管运行时。
    // scope 必须作为路径段匹配——裸子串会误中包名自带的词（如 acme）。
    const scope = (pkgName.split("/")[0] ?? "")
      .replace(/^@/, "")
      .replace(/_/g, "_?");
    const oursRe = scope
      ? new RegExp(`@${scope}[\\\\/]|runtime[\\\\/]node_modules`, "i")
      : /runtime[\\/]node_modules/i;
    if (oursRe.test(cmd)) return "ours";
    return "unscoped";
  }
  return "upstream";
}
