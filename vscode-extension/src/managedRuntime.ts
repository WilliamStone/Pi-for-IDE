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
): { version: string; dir: string; level?: number; ready: boolean; current: boolean }[] {
  const root = managedRuntimeRoot(context);
  const cur = markerVersion(context);
  const out: { version: string; dir: string; level?: number; ready: boolean; current: boolean }[] =
    [];
  const push = (version: string, dirRoot: string, current: boolean) => {
    const pkgDir = path.join(dirRoot, "node_modules", pkg);
    out.push({
      version,
      dir: pkgDir,
      level: packageLevel(pkgDir),
      ready: existsSync(path.join(pkgDir, "bin", "pi-web.js")),
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
  return out.sort((a, b) => compareVersions(b.version, a.version));
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
 * 往托管运行时安装指定版本：`npm i --prefix versions/<ver> pkg@ver`
 * → 成功后 marker 前翻。不碰运行中的旧目录。
 */
export async function installManagedPackage(
  channel: vscode.OutputChannel,
  context: vscode.ExtensionContext,
  pkg: string,
  version?: string,
  onProgress?: (message: string) => void,
): Promise<boolean> {
  const root = managedRuntimeRoot(context);

  // 目标版本：显式传入或取最高兼容版本（问 registry）。
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

  // 跨窗口安装锁（原子创建），后到者等先装完复用。
  const lockFile = path.join(root, ".installing");
  let waitedMs = 0;
  while (existsSync(lockFile) && waitedMs < 600_000) {
    await new Promise((r) => setTimeout(r, 3000));
    waitedMs += 3000;
    if (waitedMs % 15_000 < 3000) {
      channel.appendLine(`another window is installing the managed runtime; waited ${Math.round(waitedMs / 1000)}s…`);
    }
    if (!existsSync(lockFile) && managedPackageBin(context, pkg)) break;
  }
  if (existsSync(lockFile)) {
    channel.appendLine("stale install lock (>10min) removed; continuing.");
    try {
      rmSync(lockFile, { force: true });
    } catch {
      // 尽力。
    }
  }
  if (waitedMs > 0 && markerVersion(context) === targetVersion && existsSync(binPath)) {
    channel.appendLine("target version already installed by another window; reusing it.");
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

  const versionRoot = managedVersionDir(context, targetVersion);
  const spec = `${pkg}@${targetVersion}`;
  if (!isSafePkgSpec(spec)) {
    channel.appendLine(`refusing to install suspicious package spec: ${spec}`);
    release();
    return false;
  }
  channel.appendLine(`managed install (version dir ${targetVersion}): npm i --prefix "${versionRoot}" ${spec} --ignore-scripts --no-audit --no-fund`);
  channel.show(true);
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const secs = Math.round((Date.now() - startedAt) / 1000);
    onProgress?.(`downloaded ~${dirSizeMB(path.join(versionRoot, "node_modules"))} MB (${secs}s)`);
  }, 2000);
  return new Promise((resolve) => {
    const child = cp.spawn(
      "npm",
      ["i", "--prefix", versionRoot, spec, "--ignore-scripts", "--no-audit", "--no-fund"],
      { shell: true },
    );
    child.stdout?.on("data", (d: Buffer) => channel.append(d.toString()));
    child.stderr?.on("data", (d: Buffer) => channel.append(d.toString()));
    const done = (ok: boolean, extra?: string) => {
      clearInterval(timer);
      release();
      if (extra) channel.appendLine(extra);
      resolve(ok);
    };
    child.on("error", (e) => done(false, `managed install process failed to start: ${e.message}`));
    child.on("exit", (code) => {
      clearInterval(timer);
      release();
      if (code === 0 && existsSync(binPath)) {
        // marker 只前翻（新>旧才写），防并发窗口倒车覆盖。
        const cur = markerVersion(context);
        if (!cur || compareVersions(targetVersion, cur) > 0) {
          try {
            writeFileSync(path.join(root, MANAGED_MARKER), targetVersion + "\n", "utf8");
            channel.appendLine(`managed runtime switched to ${targetVersion} (marker updated).`);
          } catch (e) {
            channel.appendLine(`failed to write version marker: ${e}`);
          }
        } else {
          channel.appendLine(`marker is already ${cur} (never regresses); this install only added the directory.`);
        }
        void sweepManagedVersions(context, channel);
        resolve(true);
        return;
      }
      channel.appendLine(`managed install exited with code ${code} (bin not ready: ${!existsSync(binPath)})`);
      resolve(false);
    });
  });
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
    cp.exec(cmd, { timeout: 15_000 }, (_e, out) => resolve(out.trim().length > 0));
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
