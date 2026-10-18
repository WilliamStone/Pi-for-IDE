import * as cp from "child_process";
import { readFileSync } from "fs";
import * as path from "path";

/**
 * 版本/级别/spec 纯逻辑——不依赖 vscode，可直测。
 * 层级语义见 docs/agents/embed-protocol.md 与 managed-runtime.md。
 */

/** 扩展当前实现的桥接级别（只增）。 */
export const EMBED_PROTOCOL_SUPPORTED = 1;

/** 仍被支持的最低包级别——下线历史桥接特性时抬高它（硬底线）。 */
export const MIN_PKG_LEVEL = 1;

/** 包 package.json 声明的级别字段：piIde.level。 */
export function packageLevel(pkgDir: string): number | undefined {
  try {
    const v = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"))
      ?.piIde?.level;
    return typeof v === "number" && v >= 1 ? v : undefined;
  } catch {
    return undefined;
  }
}

/** 级别判定：缺失按 1 计（历史包均无字段且实现 v1）。 */
export function levelSupported(level: number | undefined): boolean {
  const lv = level ?? 1;
  return lv >= MIN_PKG_LEVEL && lv <= EMBED_PROTOCOL_SUPPORTED;
}

/** bin/pi-web.js → 所在包目录 → 其声明的级别。 */
export function binLevel(binPath: string): number | undefined {
  return packageLevel(path.dirname(path.dirname(binPath)));
}

/** bin/pi-web.js → 所在包目录 → 其 version。读不到按 "0.0.0"（垫底候选）。 */
export function binVersion(binPath: string): string {
  try {
    const v = JSON.parse(
      readFileSync(path.join(path.dirname(path.dirname(binPath)), "package.json"), "utf8"),
    )?.version;
    return typeof v === "string" && v ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** a>b→1, a=b→0, a<b→-1。预发版 `X.Y.Z-N` 的 N 参与比较。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number(x) || 0);
  const pb = b.split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < 4; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/**
 * 已装副本池择优：过滤级别不支持的候选后按版本取最高；
 * 版本并列时保留池内顺序先者（调用方按偏好排池序）。
 */
export function pickNewestSupported<T>(
  items: T[],
  versionOf: (item: T) => string,
  levelOf: (item: T) => number | undefined,
): T | undefined {
  const supported = items.filter((i) => levelSupported(levelOf(i)));
  return supported.length
    ? supported.reduce((a, b) => (compareVersions(versionOf(a), versionOf(b)) >= 0 ? a : b))
    : undefined;
}

/** 包名/版本 spec 的 shell 安全校验：配置值原样进 shell 会注入。 */
export function isSafePkgSpec(spec: string): boolean {
  // npm 包名是 [a-z0-9._-]+（可 scoped），版本是 semver/tag——凡含空格或
  // shell 元字符的一律拒绝。
  return /^(@[\w.-]+\/)?[\w.-]+(@[\w.^~*x-]+)?$/.test(spec) && !/[\s;&|<>$`'"\\]/.test(spec);
}

/** registry 基地址：优先用户 npm 配置（镜像源），回退官方 registry。 */
let registryBase: Promise<string> | null = null;
export function getRegistryBase(): Promise<string> {
  registryBase ??= new Promise<string>((resolve) => {
    cp.exec("npm config get registry", { timeout: 5000 }, (e, out) => {
      const u = typeof out === "string" ? out.trim() : "";
      resolve(!e && /^https?:\/\//.test(u) ? u.replace(/\/+$/, "") : "https://registry.npmjs.org");
    });
  });
  return registryBase;
}
