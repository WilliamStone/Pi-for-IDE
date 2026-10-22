import * as cp from "child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import * as path from "path";
import * as vscode from "vscode";

/**
 * 托管运行时与发行包版本管理（docs/agents/managed-runtime.md）。
 *
 * 职责：版本目录布局、current-version marker、跨窗口安装锁、
 * registry 兼容查询、版本选择、安装、旧版本清理。
 * 进程生命周期（解析链编排、spawn、握手、诊断）在 piIdeServer.ts。
 */

// ---------------------------------------------------------------------------
// 兼容级别（特性阶梯整数，两侧共享）
// ---------------------------------------------------------------------------

// 级别阶梯与版本比较抽到 ./version（纯模块，可单测）。
export {
  binLevel,
  binVersion,
  compareVersions,
  EMBED_PROTOCOL_SUPPORTED,
  isNewerVersion,
  isSafePkgSpec,
  levelSupported,
  MIN_PKG_LEVEL,
  packageLevel,
  pickNewestSupported,
} from "./version";
import {
  compareVersions,
  EMBED_PROTOCOL_SUPPORTED,
  getRegistryBase,
  isSafePkgSpec,
  levelSupported,
  MIN_PKG_LEVEL,
  packageLevel,
} from "./version";

// ---------------------------------------------------------------------------
// 布局与 marker
// ---------------------------------------------------------------------------

/** <globalStorage>/runtime——发行包的扩展自管安装目录。 */
export function managedRuntimeRoot(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "runtime");
}

const MANAGED_MARKER = "current-version";

function managedVersionDir(context: vscode.ExtensionContext, ver: string): string {
  return path.join(managedRuntimeRoot(context), "versions", ver);
}

function packageBinIn(dirRoot: string, pkg: string): string {
  return path.join(dirRoot, "node_modules", pkg, "bin", "pi-web.js");
}

function markerVersion(context: vscode.ExtensionContext): string {
  try {
    return readFileSync(
      path.join(managedRuntimeRoot(context), MANAGED_MARKER),
      "utf8",
    ).trim();
  } catch {
    return "";
  }
}

/**
 * 已装托管版本清单（降序）：版本号、目录、级别、bin 是否就绪、是否当前。
 * 用于版本选择和管理命令 UI。
 */
export function listManagedVersions(
  context: vscode.ExtensionContext,
  pkg: string,
): { version: string; dir: string; level?: number; ready: boolean; current: boolean; builtAt?: string }[] {
  const root = managedRuntimeRoot(context);
  const cur = markerVersion(context);
  const out: { version: string; dir: string; level?: number; ready: boolean; current: boolean; builtAt?: string }[] =
    [];
  const push = (version: string, dirRoot: string, current: boolean) => {
    const pkgDir = path.join(dirRoot, "node_modules", pkg);
    out.push({
      version,
      dir: pkgDir,
      level: packageLevel(pkgDir),
      ready: existsSync(path.join(pkgDir, "bin", "pi-web.js")),
      builtAt: installedBuildStamp(pkgDir).builtAt,
      current,
    });
  };
  try {
    for (const entry of readdirSync(path.join(root, "versions"))) {
      if (entry.startsWith(".")) continue;
      push(entry, path.join(root, "versions", entry), entry === cur);
    }
  } catch {
    // versions/ 不存在。
  }
  // 旧式平铺（0.1.7 之前形态）：视为最旧候选。
  const legacyDir = path.join(root, "node_modules", pkg);
  if (existsSync(path.join(legacyDir, "bin", "pi-web.js"))) {
    let legacyVer = "0.0.0-legacy";
    try {
      legacyVer = JSON.parse(readFileSync(path.join(legacyDir, "package.json"), "utf8")).version ?? legacyVer;
    } catch {
      // 版本读不出就按最旧处理。
    }
    push(legacyVer, root, false);
  }
  // 版本降序；同版本（构建戳分槽）按 builtAt 新→旧。
  return out.sort(
    (a, b) => compareVersions(b.version, a.version) || (b.builtAt ?? "").localeCompare(a.builtAt ?? ""),
  );
}

/**
 * 解析托管运行时内应使用的 bin/pi-web.js：
 * marker 版本 → 合法才用；否则版本降序扫已装目录取第一个 bin 就绪
 * 且级别兼容者；旧式平铺作最旧候选。全部失败返回 undefined。
 */
export function managedPackageBin(
  context: vscode.ExtensionContext,
  pkg: string,
  log?: (line: string) => void,
): string | undefined {
  for (const v of listManagedVersions(context, pkg)) {
    if (!v.ready) continue;
    if (!levelSupported(v.level)) {
      log?.(`managed version ${v.version} level ${v.level ?? "unknown"} is outside the supported range (${MIN_PKG_LEVEL}..${EMBED_PROTOCOL_SUPPORTED}), skipped.`);
      continue;
    }
    return path.join(v.dir, "bin", "pi-web.js");
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// registry 兼容查询
// ---------------------------------------------------------------------------

export interface RegistryCompat {
  /** 最高兼容版本（可装/可升目标）；无兼容版本为 undefined。 */
  best?: { version: string; level: number };
  /** registry 最新版本与其级别。 */
  latest?: { version: string; level: number };
  /** latest 级别超出扩展支持——需要先升级扩展。 */
  needsExtensionUpgrade: boolean;
  /** 无任何兼容版本。 */
  none: boolean;
}

/** 拉注册表全包文档，按级别过滤兼容集后取最高版本。 */
export async function queryRegistryCompat(pkg: string): Promise<RegistryCompat> {
  try {
    const res = await fetch(
      `${await getRegistryBase()}/${pkg.replace("/", "%2F")}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
    );
    const doc = (await res.json()) as {
      "dist-tags"?: { latest?: string };
      versions?: Record<string, { piIde?: { level?: number } }>;
    };
    const latestVer = doc["dist-tags"]?.latest;
    const versions = Object.entries(doc.versions ?? {}).map(([version, meta]) => ({
      version,
      level: meta.piIde?.level ?? 1,
    }));
    const latest = latestVer
      ? versions.find((v) => v.version === latestVer)
      : versions.sort((a, b) => compareVersions(b.version, a.version))[0];
    const compatible = versions
      .filter((v) => levelSupported(v.level))
      .sort((a, b) => compareVersions(b.version, a.version));
    return {
      best: compatible[0],
      latest,
      needsExtensionUpgrade: !!latest && latest.level > EMBED_PROTOCOL_SUPPORTED,
      none: compatible.length === 0,
    };
  } catch {
    return { needsExtensionUpgrade: false, none: true };
  }
}

// ---------------------------------------------------------------------------
// 构建身份（pi-web-build.json）：同版本号下区分新旧构建。
// tgz 读写与本地包解析在 ./tgz（纯 Node 模块，无 vscode 依赖）。
// ---------------------------------------------------------------------------

export type { BuildIdentity } from "./tgz";
import {
  extractTgz,
  readTgzIdentity,
  resolveLocalPackagePath,
  type BuildIdentity,
} from "./tgz";

/** 已装包目录里的构建戳（缺文件的老安装视为"无戳"——比对时最旧）。 */
export function installedBuildStamp(pkgDir: string): { builtAt?: string; gitSha?: string } {
  try {
    return JSON.parse(readFileSync(path.join(pkgDir, "pi-web-build.json"), "utf8")) as {
      builtAt?: string;
      gitSha?: string;
    };
  } catch {
    return {};
  }
}

/**
 * 版本目录名选择：
 * - 带构建戳的包永远进 `<version>.b<yyyymmddhhmmss>` 槽——已发布的同版本
 *   registry 安装占 `<version>` 槽，两者互不相撞；
 * - 同戳同槽（已装过同一构建）→ reused=true，调用方短路；
 * - 无戳（registry 路径）→ `<version>`。
 */
export function pickVersionDirName(
  versionsRoot: string,
  pkg: string,
  identity: BuildIdentity,
): { dirName: string; reused: boolean } {
  const binOk = (dirName: string) =>
    existsSync(path.join(versionsRoot, dirName, "node_modules", pkg, "bin", "pi-web.js"));
  if (!identity.builtAt) {
    return { dirName: identity.version, reused: binOk(identity.version) };
  }
  const ts = identity.builtAt.replace(/\D/g, "").slice(0, 14);
  const dirName = `${identity.version}.b${ts}`;
  return { dirName, reused: binOk(dirName) };
}

/**
 * marker 前翻判定：版本号高者赢；同版本比构建戳（ISO 串字典序=时序）。
 * 防并发窗口把 marker 倒回旧构建/旧版本。
 */
function isNewerManagedEntry(context: vscode.ExtensionContext, pkg: string, dirName: string): boolean {
  const cur = markerVersion(context);
  if (!cur) return true;
  const stripBuild = (n: string) => n.replace(/\.b\d{14}$/, "");
  const v = compareVersions(stripBuild(dirName), stripBuild(cur));
  if (v !== 0) return v > 0;
  const stampOf = (n: string) =>
    installedBuildStamp(path.join(managedRuntimeRoot(context), "versions", n, "node_modules", pkg)).builtAt ?? "";
  return stampOf(dirName) > stampOf(cur);
}

// ---------------------------------------------------------------------------
// 安装（版本目录 + 锁 + marker 前翻 + 清理）
// ---------------------------------------------------------------------------

/** 目录体积（MB），用于安装进度提示。 */
function dirSizeMB(dir: string): number {
  let total = 0;
  const walk = (d: string, depth: number): void => {
    if (depth > 12) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.isFile()) total += statSync(p).size;
      } catch {
        // 单个文件读不到就跳过。
      }
    }
  };
  try {
    walk(dir, 0);
  } catch {
    // 目录还没建出来（npm 解压早期）——0。
  }
  return Math.round(total / 1048576);
}

/**
 * npm 装包子进程：windowsHide 治 cmd 黑窗闪屏；输出全程进输出通道。
 */
function spawnNpmInstall(
  channel: vscode.OutputChannel,
  versionRoot: string,
  spec: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    // npm ≥11 在 project-scoped install 上拒绝 --ignore-scripts CLI
    // （EALLOWSCRIPTS），.npmrc 同键也进 policy 报错——但 -g 是
    // 非 project 上下文（npm.global → 检查短路），--ignore-scripts
    // 恢复合法。产物布局一致：<prefix>/node_modules/<pkg>/（多出来的
    // 顶层 .cmd/.ps1 shim 无妨）。preinstall-guard 若跑了会在实例
    // 在跑时整单中止（Windows）——版本槽安装不碰运行目录，必须跳过。
    const child = cp.spawn(
      "npm",
      ["i", "-g", "--prefix", versionRoot, `"${spec}"`, "--ignore-scripts", "--no-audit", "--no-fund"],
      { shell: true, windowsHide: true },
    );
    child.stdout?.on("data", (d: Buffer) => channel.append(d.toString()));
    child.stderr?.on("data", (d: Buffer) => channel.append(d.toString()));
    child.on("error", (e) => {
      channel.appendLine(`managed install process failed to start: ${e.message}`);
      resolve(false);
    });
    child.on("exit", (code) => {
      channel.appendLine(`managed install exited with code ${code}`);
      resolve(code === 0);
    });
  });
}

/**
 * 共享安装骨架：跨窗口锁 → install()（npm 装/本地解包）→ marker 前翻
 * （构建身份判定）→ 清理。调用方提供 install 动作与展示标签。
 */
async function runManagedInstall(
  channel: vscode.OutputChannel,
  context: vscode.ExtensionContext,
  pkg: string,
  dirName: string,
  installLabel: string,
  install: () => Promise<boolean>,
  onProgress?: (message: string) => void,
): Promise<boolean> {
  const root = managedRuntimeRoot(context);
  const binPath = packageBinIn(path.join(root, "versions", dirName), pkg);

  // 跨窗口安装锁（原子创建），后到者等先装完复用。
  const lockFile = path.join(root, ".installing");
  let waitedMs = 0;
  while (existsSync(lockFile) && waitedMs < 600_000) {
    await new Promise((r) => setTimeout(r, 3000));
    waitedMs += 3000;
    if (waitedMs % 15_000 < 3000) {
      channel.appendLine(`another window is installing the managed runtime; waited ${Math.round(waitedMs / 1000)}s…`);
    }
    if (!existsSync(lockFile) && existsSync(binPath)) break;
  }
  if (existsSync(lockFile)) {
    channel.appendLine("stale install lock (>10min) removed; continuing.");
    try {
      rmSync(lockFile, { force: true });
    } catch {
      // 尽力。
    }
  }
  if (waitedMs > 0 && markerVersion(context) === dirName && existsSync(binPath)) {
    channel.appendLine("target build already installed by another window; reusing it.");
    return true;
  }
  let lockFd: number | undefined;
  try {
    mkdirSync(root, { recursive: true });
    lockFd = openSync(lockFile, "wx");
  } catch {
    if (existsSync(binPath)) return true;
    channel.appendLine("install lock held by another window; waiting for it…");
    for (let i = 0; i < 200 && existsSync(lockFile); i++) {
      await new Promise((r) => setTimeout(r, 3000));
    }
    return existsSync(binPath);
  }
  const release = () => {
    try {
      if (lockFd !== undefined) closeSync(lockFd);
    } catch {
      // ignore
    }
    try {
      rmSync(lockFile, { force: true });
    } catch {
      // ignore
    }
  };

  const versionRoot = path.join(root, "versions", dirName);
  channel.appendLine(`managed install (version dir ${dirName}): ${installLabel}`);
  channel.show(true);
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const secs = Math.round((Date.now() - startedAt) / 1000);
    onProgress?.(`installed ~${dirSizeMB(path.join(versionRoot, "node_modules"))} MB (${secs}s)`);
  }, 2000);
  const ok = await install();
  clearInterval(timer);
  release();
  if (ok && existsSync(binPath)) {
    // marker 只前翻（新版本或同版本新构建才写），防并发窗口倒车覆盖。
    if (isNewerManagedEntry(context, pkg, dirName)) {
      try {
        writeFileSync(path.join(root, MANAGED_MARKER), dirName + "\n", "utf8");
        channel.appendLine(`managed runtime switched to ${dirName} (marker updated).`);
      } catch (e) {
        channel.appendLine(`failed to write version marker: ${e}`);
      }
    } else {
      channel.appendLine(`marker is already ${markerVersion(context)} (never regresses); this install only added the directory.`);
    }
    void sweepManagedVersions(context, channel);
    return true;
  }
  channel.appendLine(`managed install failed (bin not ready: ${!existsSync(binPath)})`);
  return false;
}

/**
 * registry 安装：目标版本显式传入或取最高兼容版本（问 registry）。
 */
export async function installManagedPackage(
  channel: vscode.OutputChannel,
  context: vscode.ExtensionContext,
  pkg: string,
  version?: string,
  onProgress?: (message: string) => void,
): Promise<boolean> {
  let targetVersion = version;
  if (!targetVersion || targetVersion === "latest") {
    const compat = await queryRegistryCompat(pkg);
    if (compat.needsExtensionUpgrade && compat.latest) {
      channel.appendLine(
        `the latest package ${compat.latest.version} (level ${compat.latest.level}) requires a newer extension (supported ≤${EMBED_PROTOCOL_SUPPORTED}). Please upgrade Pi for IDE from the marketplace first.`,
      );
      return false;
    }
    if (!compat.best) {
      channel.appendLine("no compatible version available in the registry.");
      return false;
    }
    targetVersion = compat.best.version;
    channel.appendLine(`selected highest compatible version ${targetVersion} (level ${compat.best.level})`);
  }
  const binPath = packageBinIn(managedVersionDir(context, targetVersion), pkg);

  // 已是当前版本且就绪 → 无操作。
  if (markerVersion(context) === targetVersion && existsSync(binPath)) {
    channel.appendLine(`managed runtime is already ${targetVersion}; nothing to install.`);
    return true;
  }
  const spec = `${pkg}@${targetVersion}`;
  if (!isSafePkgSpec(spec)) {
    channel.appendLine(`refusing to install suspicious package spec: ${spec}`);
    return false;
  }
  const versionRoot = managedVersionDir(context, targetVersion);
  return runManagedInstall(
    channel,
    context,
    pkg,
    targetVersion,
    `npm i -g --prefix "${versionRoot}" ${spec} --ignore-scripts --no-audit --no-fund`,
    () => spawnNpmInstall(channel, versionRoot, spec),
    onProgress,
  );
}

/**
 * 本地 tgz 安装：Pi for IDE.localPackage 指向的发行包。读构建身份→级别
 * 校验→版本目录选择（构建戳分槽）→同一 runManagedInstall 骨架。
 * 已装同一构建时短路（幂等）。
 */
export async function installManagedLocalPackage(
  channel: vscode.OutputChannel,
  context: vscode.ExtensionContext,
  configPath: string,
  onProgress?: (message: string) => void,
): Promise<boolean> {
  const tgzPath = resolveLocalPackagePath(configPath, "");
  if (!tgzPath) {
    channel.appendLine(`no usable local package at ${configPath} (not a .tgz, or directory has none).`);
    return false;
  }
  const id = readTgzIdentity(tgzPath);
  if (!id?.version) {
    channel.appendLine(`cannot read package identity from ${tgzPath} (tar unavailable or not an npm tarball).`);
    return false;
  }
  const pkg = id.name ?? "";
  if (!pkg) {
    channel.appendLine("local tarball has no package name.");
    return false;
  }
  if (!levelSupported(id.level)) {
    channel.appendLine(
      `local package ${id.version} (level ${id.level ?? "unknown"}) is outside the supported range (${MIN_PKG_LEVEL}..${EMBED_PROTOCOL_SUPPORTED}); it may require a newer Pi for IDE extension.`,
    );
    return false;
  }
  const versionsRoot = path.join(managedRuntimeRoot(context), "versions");
  const pick = pickVersionDirName(versionsRoot, pkg, id);
  if (pick.reused && markerVersion(context) === pick.dirName) {
    channel.appendLine(`local package is already the current build (${pick.dirName}); nothing to install.`);
    return true;
  }
  const binPath = packageBinIn(path.join(versionsRoot, pick.dirName), pkg);
  if (pick.reused && existsSync(binPath)) {
    channel.appendLine(`build ${pick.dirName} already installed; only the marker may need flipping.`);
    // 已装但非当前——翻 marker（新版本/新构建时才写）。
    if (isNewerManagedEntry(context, pkg, pick.dirName)) {
      writeFileSync(path.join(managedRuntimeRoot(context), MANAGED_MARKER), pick.dirName + "\n", "utf8");
      channel.appendLine(`managed runtime switched to ${pick.dirName} (marker updated).`);
    }
    return true;
  }
  channel.appendLine(
    `installing local package ${id.name}@${id.version}` +
      (id.builtAt ? ` built ${id.builtAt}` : "") + (id.gitSha ? ` (${id.gitSha})` : ""),
  );
  // 本地 tgz 直接解包——standalone 包自带全部 node_modules，bin/pi-web.js
  // 只依赖本地文件与 node 内置，无需 npm 解依赖（省掉下载与闪窗）。
  const destPkgDir = path.join(versionsRoot, pick.dirName, "node_modules", pkg);
  return runManagedInstall(
    channel,
    context,
    pkg,
    pick.dirName,
    `extract ${tgzPath} → ${destPkgDir}`,
    () => Promise.resolve(extractTgz(tgzPath, destPkgDir)),
    onProgress,
  );
}

/** 人工切换 marker（管理命令用）——允许降级，不受"只前翻"限制。 */
export function setManagedMarker(
  context: vscode.ExtensionContext,
  version: string,
): void {
  writeFileSync(
    path.join(managedRuntimeRoot(context), MANAGED_MARKER),
    version + "\n",
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// 旧版本清理：低于 marker 且无运行占用的目录可删；高于/被占用保留。
// ---------------------------------------------------------------------------

/** 是否有进程命令行含目标目录（Windows/Linux 尽力而为）。 */
async function dirInUse(dir: string): Promise<boolean> {
  const needle = dir.replace(/\\/g, "\\\\");
  return new Promise((resolve) => {
    const cmd =
      process.platform === "win32"
        ? `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \\$_.CommandLine -match '${needle.replace(/'/g, "''")}' } | Select-Object -ExpandProperty ProcessId"`
        : `pgrep -f '${needle.replace(/'/g, "'\\''")}'`;
    cp.exec(cmd, { timeout: 15_000, windowsHide: true }, (_e, out) => resolve(out.trim().length > 0));
  });
}

export async function sweepManagedVersions(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
): Promise<void> {
  const root = managedRuntimeRoot(context);
  const cur = markerVersion(context);
  if (!cur) return;
  const versionsDir = path.join(root, "versions");
  let entries: string[];
  try {
    entries = readdirSync(versionsDir).filter((e) => !e.startsWith("."));
  } catch {
    return;
  }
  for (const ver of entries) {
    if (ver === cur) continue;
    // 高于 marker 的保留（可能协议不兼容暂不可用，未来扩展升级后可启用）。
    if (compareVersions(ver, cur) > 0) continue;
    const dir = path.join(versionsDir, ver);
    if (await dirInUse(dir)) {
      channel.appendLine(`old version ${ver} is in use by a running instance; cleanup skipped.`);
      continue;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
      channel.appendLine(`old managed version cleaned up: ${ver}`);
    } catch {
      // 删不动就下次再清。
    }
  }
}
