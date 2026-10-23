// 服务器入口解析链 + 包操作——从 piIdeServer.ts 拆出。
// 解析顺序（见类注释与 docs/agents/managed-runtime.md）：
//   executablePath 配置 → 内置 resources → 全局 npm 包 → PATH shim → 托管运行时
// 每条腿校验 piIde.level；解析不出则由 managed 腿现场安装。

import * as cp from "child_process";
import * as crypto from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  binLevel,
  binVersion,
  compareVersions,
  installManagedLocalPackage,
  installManagedPackage,
  installedBuildStamp,
  isNewerVersion,
  isSafePkgSpec,
  levelSupported,
  managedPackageBin,
  pickNewestSupported,
  queryRegistryCompat,
} from "./managedRuntime";
import { readTgzIdentity, resolveLocalPackagePath, type BuildIdentity } from "./tgz";
import { emitServerStatus, outputChannel } from "./server-status";
import { formatBuildStamp, singleFlight } from "./version";
import { ideRunDir, withServerLock } from "./server-lock";
import { piConfig } from "./config";
import { localUpgradeSig } from "./upgradeNotice";

// ---------------------------------------------------------------------------
// 降级发现事件：解析层只产出"解析副本比本地包旧"的事实——提示去哪条路径
// 打扰用户归扩展层的 upgrade 编排（三条触达路径共用去重）。解析层弹
// UI 是分层违例，第四条提示路径就是从这里长出来的。
// ---------------------------------------------------------------------------

export interface DowngradeWarning {
  /** 用户可读的一行警告。 */
  warn: string;
  /** 与 upgradeActionSig 同口径的 local: 签名（去重凭据）。 */
  sig: string;
}

const downgradeListeners = new Set<(w: DowngradeWarning) => void>();
export function onDowngradeWarning(cb: (w: DowngradeWarning) => void): vscode.Disposable {
  downgradeListeners.add(cb);
  return { dispose: () => void downgradeListeners.delete(cb) };
}
function emitDowngradeWarning(w: DowngradeWarning): void {
  for (const cb of downgradeListeners) cb(w);
}

export type SpawnTarget =
  /** node <server.js>——standalone 产物，只认 PORT/HOSTNAME 环境变量。 */
  | { mode: "script"; path: string }
  /** node <bin/pi-web.js>——npm 包入口，接受 --port/--hostname/--no-open。 */
  | { mode: "bin"; path: string };

/**
 * 用 `npm root -g` 找全局 node_modules，返回其中 `<pkg>/bin/pi-web.js`
 * 的绝对路径（不存在则 undefined）。npm 不在 PATH（如 nvm 未生效）时安静返回 undefined。
 */
export function resolveGlobalPackageBin(pkg: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    cp.exec("npm root -g", { timeout: 10_000, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      const binPath = path.join(stdout.trim(), pkg, "bin", "pi-web.js");
      resolve(existsSync(binPath) ? binPath : undefined);
    });
  });
}

/**
 * 在 PATH 上找 `pi-web` shim（`where`/`which`），从 shim 内容里提取它实际
 * 调用的 bin/pi-web.js 路径。npm/pnpm/yarn/bun 的全局 shim 都会内嵌真实
 * 入口（`%~dp0\..\...\bin\pi-web.js` 或 `$basedir/...`），各包管理器通用。
 *
 * shim 只按命令名匹配，背后可能挂着旧 unscoped 包（pi-web-for-ide）或
 * 上游原版 @agegr/pi-web——因此还要读目标包的 package.json，name 与
 * expectedPkg 不一致时跳过该 shim（交给后续 npx 兜底拿到正确发行包）。
 * 找不到或解析失败时安静返回 undefined。
 */
export async function resolvePathShimBin(
  expectedPkg: string,
  log?: (line: string) => void,
): Promise<string | undefined> {
  // 只认本包专属命令名 pi-web-for-ide——上游 pi-web 同名 shim 不做
  // 回退探测：本包不在就直接走 npx/安装流程，杜绝误拉原版。
  return resolveSingleShimBin("pi-web-for-ide", expectedPkg, log);
}

function resolveSingleShimBin(
  binName: string,
  expectedPkg: string,
  log?: (line: string) => void,
): Promise<string | undefined> {
  const cmd = process.platform === "win32" ? `where ${binName}` : `which ${binName}`;
  return new Promise((resolve) => {
    cp.exec(cmd, { timeout: 10_000, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      const shimDirOf = (line: string) => path.dirname(line);
      for (const line of stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        // 只要脚本 shim（.cmd 或无扩展名）；.ps1/.exe 不经此通道。
        if (/\.(ps1|exe|bat)$/i.test(line)) continue;
        let content: string;
        try {
          content = readFileSync(line, "utf8");
        } catch {
          continue;
        }
        // pnpm 等 shim 尾部带 `# cmd-shim-target=<绝对路径>` 注解，最可靠。
        let target: string | undefined;
        const tagged = content.match(/^#?\s*cmd-shim-target=(\S+)/m);
        if (tagged) target = tagged[1];
        // 兜底：取第一个引号包裹的 …/bin/<binName>.js，把开头的 %~dp0 /
        // $basedir / $basedir_win 等"shim 目录变量"归一化成相对路径。
        if (!target || !existsSync(target)) {
          const m = content.match(new RegExp(`["']([^"']*bin[/\\\\]${binName}\\.js)["']`));
          if (!m) continue;
          target = path.resolve(
            shimDirOf(line),
            m[1].replace(/^(%~dp0[\\/]?|\$[A-Za-z_][A-Za-z0-9_]*[\\/]?)/, "./"),
          );
        }
        if (existsSync(target)) {
          // 校验 shim 背后真实包的 name——名字不符说明挂的是别的包。
          let actualName: string | undefined;
          try {
            actualName = JSON.parse(
              readFileSync(path.join(path.dirname(path.dirname(target)), "package.json"), "utf8"),
            ).name;
          } catch {
            // 读不到 package.json 视为身份不明，同样跳过。
          }
          if (actualName !== expectedPkg) {
            log?.(
              `PATH shim ${line} points to ${actualName ?? "unknown package"} (expected ${expectedPkg}), skipped.`,
            );
            continue;
          }
          resolve(target);
          return;
        }
      }
      resolve(undefined);
    });
  });
}

/** 探测可用的包管理器：优先 pnpm（默认执行装包脚本），其次 npm。 */
function detectPackageManager(): Promise<"pnpm" | "npm" | undefined> {
  const tryCmd = (cmd: string): Promise<boolean> =>
    new Promise((r) => cp.exec(`${cmd} --version`, { timeout: 8_000, windowsHide: true }, (e) => r(!e)));
  return tryCmd("pnpm").then((ok) => (ok ? "pnpm" : tryCmd("npm").then((ok2) => (ok2 ? "npm" : undefined))));
}

/**
 * 全局安装 pi-web 发行包（流式输出到扩展的输出通道）。返回是否成功。
 * 由"找不到服务器"的引导按钮和升级流程共用。
 */
export async function installPiWebPackage(
  channel: vscode.OutputChannel,
  pkg: string,
  version?: string,
): Promise<boolean> {
  const pm = await detectPackageManager();
  if (!pm) {
    channel.appendLine("pnpm/npm not found; cannot install automatically.");
    return false;
  }
  const spec = version ? `${pkg}@${version}` : pkg;
  if (!isSafePkgSpec(spec)) {
    channel.appendLine(`refusing to install suspicious package spec: ${spec}`);
    return false;
  }
  const cmd = `${pm} i -g "${spec.replace(/"/g, "")}"`;
  channel.appendLine(`run: ${cmd}`);
  channel.show(true);
  // 全局安装也是临界区资源：两个窗口并发 npm i -g 同一包会互踩文件。
  return withServerLock("global-install", () => new Promise<boolean>((resolve) => {
    const child = cp.spawn(pm, ["i", "-g", spec], { shell: true, windowsHide: true });
    child.stdout?.on("data", (d: Buffer) => channel.append(d.toString()));
    child.stderr?.on("data", (d: Buffer) => channel.append(d.toString()));
    child.on("error", (e) => {
      channel.appendLine(`install process failed to start: ${e.message}`);
      resolve(false);
    });
    child.on("exit", (code) => {
      channel.appendLine(`install process exited with code ${code}`);
      resolve(code === 0);
    });
  }), undefined, channel);
}

/**
 * 发行包升级检查：解析当前在用副本 + 查 registry 最高兼容版本。
 * 返回 {current, managed, best, latest, needsExtensionUpgrade, none}；
 * 未安装/检查失败返回 undefined。详见 docs/agents/managed-runtime.md §5。
 */
export async function checkPiWebUpdate(
  pkg: string,
  context?: vscode.ExtensionContext,
): Promise<
  | {
      current: string;
      /** 当前在用副本的构建戳（无戳老安装为 undefined）。 */
      currentBuiltAt?: string;
      managed: boolean;
      best?: string;
      latest?: string;
      latestLevel?: number;
      needsExtensionUpgrade: boolean;
      none: boolean;
    }
  | undefined
> {
  const managedBin = context ? managedPackageBin(context, pkg) : undefined;
  // 与 resolveServerTarget 同池择优——报告的 current 必须是实际会跑的那份。
  const binPath = pickNewestSupported(
    [
      await resolveGlobalPackageBin(pkg),
      await resolvePathShimBin(pkg),
      managedBin,
    ].filter((b): b is string => !!b),
    binVersion,
    binLevel,
  );
  const managed = !!managedBin && binPath === managedBin;
  if (!binPath) return undefined;
  const pkgDir = path.dirname(path.dirname(binPath));
  const pkgJson = path.join(pkgDir, "package.json");
  let current: string;
  try {
    current = JSON.parse(readFileSync(pkgJson, "utf8")).version;
  } catch {
    return undefined;
  }
  if (!current) return undefined;
  const compat = await queryRegistryCompat(pkg);
  if (!compat.latest) return undefined;
  return {
    current,
    currentBuiltAt: installedBuildStamp(pkgDir).builtAt,
    managed,
    best: compat.best?.version,
    latest: compat.latest.version,
    latestLevel: compat.latest.level,
    needsExtensionUpgrade: compat.needsExtensionUpgrade,
    none: compat.none,
  };
}

/**
 * 来源选择（Pi for IDE.installSource）→ 实际安装腿的判定。
 * auto / prefer-remote 都两边比：版本高者赢；同版本 auto→本地、
 * prefer-remote→在线。本地候选缺席/被拒时回落在线；反之亦然。
 */
export function pickInstallFlow(
  source: string,
  localVersion: string | undefined,
  remoteBest: string | undefined,
): "local" | "registry" {
  if (source === "local") return "local";
  if (source === "registry") return "registry";
  // auto / prefer-remote：两边比。
  if (!localVersion) return "registry";
  if (!remoteBest) return "local";
  const cmp = compareVersions(localVersion, remoteBest);
  if (cmp !== 0) return cmp > 0 ? "local" : "registry";
  return source === "prefer-remote" ? "registry" : "local";
}

// ---------------------------------------------------------------------------
// 升级计划：采集各侧候选 → 对照报告 → flow → 结论动作。
// piIde.upgrade 命令与后台检查共用这一个判定——UI 各自渲染，逻辑不重复。
// ---------------------------------------------------------------------------

export interface UpgradePlan {
  installSource: string;
  localTgz: string;
  /** 各侧采集结果（单边模式未查的一侧为 undefined）。 */
  local?: LocalCheck;
  remote?: RemoteCheck;
  /** pickInstallFlow 的结论——装哪条腿。 */
  flow: "local" | "registry";
  /** 当前在用副本（version + builtAt）。 */
  current?: { version: string; builtAt?: string };
  /** 对照报告行（installSource / local / registry / current）。 */
  report: string[];
  action: UpgradeAction;
}

/** 计划结论：可安装的本地/在线动作，或"无可动作"及其原因。 */
export type UpgradeAction =
  | { kind: "local"; label: string; recommended: boolean }
  | { kind: "registry"; version: string; managed: boolean }
  | { kind: "none"; reason: string };

export type LocalCheck = NonNullable<ReturnType<typeof checkLocalPackageUpdate>>;
export type RemoteCheck = NonNullable<Awaited<ReturnType<typeof checkPiWebUpdate>>>;

/** "2026-10-20T02:46:13.857Z" → " built 2026-10-20 02:46"（空则空串）——升级报告/通知/版本列表共用。 */
const fmtBuild = formatBuildStamp;

// 并发去重两层：singleFlight 挡同进程并发；withServerLock + last-check
// 计划缓存挡跨窗口重复——"检查版本"是只读但昂贵（registry fetch 10s
// 超时 + 全量 gunzip tgz 读身份），一窗算完 60s 内他窗直接复用。
const PLAN_CACHE_TTL_MS = 60_000;

function planCacheKey(
  context: vscode.ExtensionContext,
  pkg: string,
  installSource: string,
  localTgz: string,
): string {
  let tgzId = "absent";
  try {
    const st = statSync(localTgz);
    tgzId = st.isDirectory() ? `d:${st.mtimeMs}` : `f:${st.mtimeMs}:${st.size}`;
  } catch {
    // 路径缺失或不可读都按 absent——localTgz 可能是目录（目录 mtime 随
    // 新 tgz 落盘变化），缓存键只需区分"包内容换没换"。
  }
  return crypto
    .createHash("sha1")
    .update([pkg, installSource, localTgz, tgzId, context.globalStorageUri.fsPath].join("|"))
    .digest("hex")
    .slice(0, 12);
}

function planCacheFile(key: string): string {
  return path.join(ideRunDir(), `upgrade-plan-${key}.json`);
}

function readPlanCache(key: string): UpgradePlan | undefined {
  try {
    const raw = JSON.parse(readFileSync(planCacheFile(key), "utf8")) as { at: number; plan: UpgradePlan };
    if (Date.now() - raw.at < PLAN_CACHE_TTL_MS) {
      return { ...raw.plan, report: ["(reused a check another window just finished)", ...raw.plan.report] };
    }
  } catch {
    // 缓存缺失/损坏 = miss，静默。
  }
  return undefined;
}

function writePlanCache(key: string, plan: UpgradePlan): void {
  try {
    const file = planCacheFile(key);
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ at: Date.now(), plan }));
    renameSync(tmp, file);
  } catch {
    // 缓存写失败无碍——下次多跑一遍而已。
  }
}

export const planUpgrade: typeof planUpgradeUncached = singleFlight(
  (context, pkg, installSource, localTgz) =>
    withServerLock(
      "upgrade-check",
      async () => {
        const key = planCacheKey(context, pkg, installSource, localTgz);
        return readPlanCache(key)
          ?? (async () => {
            const plan = await planUpgradeUncached(context, pkg, installSource, localTgz);
            writePlanCache(key, plan);
            return plan;
          })();
      },
      undefined,
      outputChannel(),
    ),
);

async function planUpgradeUncached(
  context: vscode.ExtensionContext,
  pkg: string,
  installSource: string,
  localTgz: string,
): Promise<UpgradePlan> {
  // 各侧候选按模式采集：单边模式不查对侧。
  const local = localTgz && installSource !== "registry"
    ? checkLocalPackageUpdate(localTgz, context, pkg)
    : undefined;
  const remote = installSource !== "local" ? await checkPiWebUpdate(pkg, context) : undefined;
  const flow = pickInstallFlow(
    installSource,
    local?.candidate && !local.reason ? local.candidate.version : undefined,
    remote?.best,
  );
  const current = local?.current
    ?? (remote ? { version: remote.current, builtAt: remote.currentBuiltAt } : undefined);

  const report = [
    `installSource: ${installSource}`,
    localTgz
      ? `local: ${local?.resolvedPath ?? localTgz} → ${local?.candidate
          ? `${local.candidate.version}${fmtBuild(local.candidate.builtAt)}${local.candidate.gitSha ? ` (${local.candidate.gitSha})` : ""}`
          : local?.reason ?? "no usable package"}${local?.candidate && local.reason ? ` — refused: ${local.reason}` : ""}`
      : "local: (localPackage not set)",
    installSource === "local"
      ? "registry: (not queried — local mode)"
      : `registry: ${remote ? `${remote.best ? `best ${remote.best}` : "no compatible version"} (latest ${remote.latest ?? "?"})` : "unreachable"}`,
    `current: ${current ? `${current.version}${fmtBuild(current.builtAt)}` : "none"}`,
  ];

  let action: UpgradePlan["action"];
  if (flow === "local") {
    if (!local?.candidate) {
      action = { kind: "none", reason: `cannot read package identity at ${localTgz}` };
    } else if (local.reason) {
      action = { kind: "none", reason: `local package refused — ${local.reason}` };
    } else {
      const c = local.candidate;
      action = {
        kind: "local",
        label: `${c.version}${fmtBuild(c.builtAt)}${c.gitSha ? ` (${c.gitSha})` : ""}`,
        recommended: local.isNewer,
      };
    }
  } else {
    if (!remote) {
      action = { kind: "none", reason: "no installed copy or registry unreachable" };
    } else if (remote.needsExtensionUpgrade) {
      action = {
        kind: "none",
        reason: `${pkg} ${remote.latest} (level ${remote.latestLevel}) requires a newer Pi for IDE extension — upgrade the extension first`,
      };
    } else if (!remote.best || !isNewerVersion(remote.best, remote.current)) {
      action = { kind: "none", reason: `already at the latest compatible version (${remote.current})` };
    } else {
      action = { kind: "registry", version: remote.best, managed: remote.managed };
    }
  }
  return { installSource, localTgz, local, remote, flow, current, report, action };
}

/**
 * 本地包检查（Pi for IDE.localPackage）：把 tgz 的构建身份与当前会跑的
 * 那份副本比——版本高者新；同版本比构建戳（builtAt）；戳缺失时只有版本
 * 不同才报新（无戳无法判同版本新旧，保守不扰）。
 */
export function checkLocalPackageUpdate(
  configPath: string,
  context: vscode.ExtensionContext,
  pkg: string,
):
  | {
      /** 实际解析到的 tgz 文件（目录配置时挑出的最新者）。 */
      resolvedPath?: string;
      current?: { version: string; builtAt?: string };
      candidate?: BuildIdentity;
      isNewer: boolean;
      reason?: string;
    }
  | undefined {
  const tgzPath = resolveLocalPackagePath(configPath, pkg);
  if (!tgzPath) {
    return {
      isNewer: false,
      reason: existsSync(configPath)
        ? `no matching .tgz at ${configPath} (directory has none for ${pkg})`
        : `path does not exist: ${configPath}`,
    };
  }
  const id = readTgzIdentity(tgzPath);
  if (!id?.version) {
    return { resolvedPath: tgzPath, isNewer: false, reason: `cannot read package/package.json in ${tgzPath}` };
  }
  if (id.name && id.name !== pkg) {
    return { resolvedPath: tgzPath, candidate: id, isNewer: false, reason: `package name mismatch: tarball is ${id.name}, configured package is ${pkg}` };
  }
  if (!levelSupported(id.level)) {
    return { resolvedPath: tgzPath, candidate: id, isNewer: false, reason: `level ${id.level ?? "unknown"} outside supported range — may need a newer extension` };
  }
  const binPath = managedPackageBin(context, pkg);
  let current: { version: string; builtAt?: string } | undefined;
  if (binPath) {
    const pkgDir = path.dirname(path.dirname(binPath));
    try {
      current = {
        version: JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")).version,
        ...installedBuildStamp(pkgDir),
      };
    } catch {
      current = { version: binVersion(binPath) ?? "unknown" };
    }
  }
  if (!current) return { resolvedPath: tgzPath, candidate: id, isNewer: true };
  const v = compareVersions(id.version, current.version);
  const isNewer = v > 0 || (v === 0 && !!id.builtAt && id.builtAt > (current.builtAt ?? ""));
  return { resolvedPath: tgzPath, candidate: id, current, isNewer };
}

/**
 * 按优先级解析服务器入口：executablePath → 内置 resources → 全局包 →
 * PATH shim → 托管运行时（缺失则现场安装）。返回 SpawnTarget 或 undefined。
 */
export async function resolveServerTarget(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
  pkg: string,
): Promise<SpawnTarget | undefined> {
  const config = piConfig();

  // 1) 显式配置：接受 standalone server.js 或包内 bin/pi-web.js。
  const configured = config.get<string>("executablePath")?.trim();
  if (configured) {
    if (existsSync(configured)) {
      const target: SpawnTarget = path.basename(configured) === "server.js"
        ? { mode: "script", path: configured }
        : { mode: "bin", path: configured };
      channel.appendLine(`pi-web entry (configured): ${configured} [${target.mode}]`);
      return target;
    }
    channel.appendLine(`"Pi for IDE.executablePath" does not exist, ignored: ${configured}`);
  }

  // 2) 过渡期兼容：扩展内置的 standalone 产物（停止打包后该文件自然不存在）。
  const bundled = path.join(context.extensionPath, "resources", "pi-web", "server.js");
  if (existsSync(bundled)) {
    channel.appendLine(`pi-web entry (bundled): ${bundled}`);
    return { mode: "script", path: bundled };
  }

  // 3-5) 已装副本池：全局包 / PATH shim / 托管运行时——同一池内取最高
  // 兼容版本。腿序不是优先级：历史全局安装不该永久影子化托管升级
  // （曾踩"升级后仍跑旧版"的坑）；要钉版本走 executablePath 配置。
  // 同版本多副本按池顺序取先者（global > shim > managed），结果确定。
  const candidates = [
    { bin: await resolveGlobalPackageBin(pkg), leg: "global install" },
    { bin: await resolvePathShimBin(pkg, (l) => channel.appendLine(l)), leg: "PATH shim" },
    { bin: managedPackageBin(context, pkg, (l) => channel.appendLine(l)), leg: "managed runtime" },
  ].filter((c): c is { bin: string; leg: string } => !!c.bin);
  for (const c of candidates) {
    const lv = binLevel(c.bin);
    if (!levelSupported(lv)) {
      channel.appendLine(
        `${c.leg} package level ${lv ?? "unknown"} is outside the supported range, skipped.`,
      );
    }
  }
  const best = pickNewestSupported(
    candidates,
    (c) => binVersion(c.bin),
    (c) => binLevel(c.bin),
    // 同版本构建戳决胜：升级装进托管槽的新构建不该被同版旧全局/旧 shim
    // 永久影子化（曾踩"装了新版跑的还是旧版"）。包目录 = bin/../../。
    (c) => installedBuildStamp(path.resolve(c.bin, "..", "..")).builtAt,
  );
  if (best) {
    const extra = candidates.length > 1 ? ` (newest of ${candidates.length} installed copies)` : "";
    channel.appendLine(`pi-web entry (${best.leg}): ${best.bin}${extra}`);
    // 解析副本比配置的本地包旧——managed 槽空档时被全局/PATH 残包抢跑
    // 是无感降级（0.12.2-1 顶班、view=chat 静默失效的实证）。解析点
    // 直接告警；registry 侧的新旧比较归后台升级检查，不进热路径。
    const localTgz = config.get<string>("localPackage")?.trim();
    if (localTgz) {
      const local = checkLocalPackageUpdate(localTgz, context, pkg);
      const c = local?.candidate;
      if (c && !local?.reason) {
        const stamp = installedBuildStamp(path.resolve(best.bin, "..", "..")).builtAt;
        const resolvedVer = binVersion(best.bin) ?? "0.0.0";
        const v = compareVersions(c.version, resolvedVer);
        const newer = v > 0 || (v === 0 && !!c.builtAt && c.builtAt > (stamp ?? ""));
        if (newer) {
          const warn = `resolved server copy ${resolvedVer}${fmtBuild(stamp)} is older than local package ${c.version}${fmtBuild(c.builtAt)}`;
          channel.appendLine(`⚠ ${warn} — run "Pi for IDE: Upgrade Server Component".`);
          // 与升级计划同一签名（localUpgradeSig = local:${a.label}）——
          // UI 弹不弹由监听方（upgrade 编排层）按共享标记定。
          emitDowngradeWarning({ warn, sig: localUpgradeSig(c) });
        }
      }
    }
    emitServerStatus("Starting local server…");
    return { mode: "bin", path: best.bin };
  }

  // 无兼容已装副本→现场安装（managed 腿兜底）。尊重 installSource：
  // local 只装本地包（不碰 registry——e2e 与离线环境靠这条）；auto 有
  // 本地候选优先本地（比 registry 下载更快、dev 下通常更新）；
  // prefer-remote 先 registry，失败再本地。
  const installSource = (config.get<string>("installSource") ?? "auto").trim();
  const localTgzPath = config.get<string>("localPackage")?.trim();
  const local = localTgzPath && installSource !== "registry"
    ? checkLocalPackageUpdate(localTgzPath, context, pkg)
    : undefined;
  const localUsable = !!local?.candidate && !local.reason;
  const wantLocal =
    installSource === "local" ||
    (installSource === "auto" && localUsable);
  const runInstall = async (
    useLocal: boolean,
    progress: vscode.Progress<{ message: string }>,
  ): Promise<boolean> =>
    useLocal
      ? installManagedLocalPackage(channel, context, localTgzPath!, (msg) =>
          progress.report({ message: msg }),
        )
      : installManagedPackage(channel, context, pkg, undefined, (msg) =>
          progress.report({ message: msg }),
        );
  const statusText = wantLocal
    ? "Installing the server component from the local package…"
    : "Downloading and installing the server component (~540MB on disk, slower on first run)…";
  emitServerStatus(statusText);
  if (installSource === "local" && !localUsable) {
    channel.appendLine(
      `installSource=local but no usable package at ${localTgzPath ?? "(unset)"}: ${local?.reason ?? "no candidate"} — refusing to fall back to the registry.`,
    );
    return undefined;
  }
  channel.appendLine(
    wantLocal
      ? `managed runtime missing; installing from local package…`
      : `managed runtime missing; running npm --prefix install…`,
  );
  let installed = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "First run: preparing the Pi for IDE server runtime…",
    },
    (progress) => runInstall(wantLocal, progress),
  );
  // prefer-remote：registry 失败后本地包仍可用则兜一手。
  if (!installed && !wantLocal && installSource !== "registry" && localUsable) {
    channel.appendLine("registry install failed; falling back to the local package…");
    installed = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "First run: installing the Pi for IDE server runtime…",
      },
      (progress) => runInstall(true, progress),
    );
  }
  const managedBinAfter = managedPackageBin(context, pkg, (l) => channel.appendLine(l));
  if (installed && managedBinAfter) {
    channel.appendLine(`pi-web entry (managed runtime): ${managedBinAfter}`);
    emitServerStatus("Starting local server…");
    return { mode: "bin", path: managedBinAfter };
  }
  channel.appendLine(`managed install failed (installed=${installed}) — no usable server entry.`);
  return undefined;
}
