// 服务器入口解析链 + 包操作——从 piIdeServer.ts 拆出。
// 解析顺序（见类注释与 docs/agents/managed-runtime.md）：
//   executablePath 配置 → 内置 resources → 全局 npm 包 → PATH shim → 托管运行时
// 每条腿校验 piIde.level；解析不出则由 managed 腿现场安装。

import * as cp from "child_process";
import { existsSync, readFileSync } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  binLevel,
  binVersion,
  installManagedPackage,
  isSafePkgSpec,
  levelSupported,
  managedPackageBin,
  pickNewestSupported,
  queryRegistryCompat,
} from "./managedRuntime";
import { emitServerStatus } from "./server-status";

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
    cp.exec("npm root -g", { timeout: 10_000 }, (err, stdout) => {
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
    cp.exec(cmd, { timeout: 10_000 }, (err, stdout) => {
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
    new Promise((r) => cp.exec(`${cmd} --version`, { timeout: 8_000 }, (e) => r(!e)));
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
  return new Promise((resolve) => {
    const child = cp.spawn(pm, ["i", "-g", spec], { shell: true });
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
  });
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
  const pkgJson = path.join(path.dirname(path.dirname(binPath)), "package.json");
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
    managed,
    best: compat.best?.version,
    latest: compat.latest.version,
    latestLevel: compat.latest.level,
    needsExtensionUpgrade: compat.needsExtensionUpgrade,
    none: compat.none,
  };
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
  const config = vscode.workspace.getConfiguration("Pi for IDE");

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
  const best = pickNewestSupported(candidates, (c) => binVersion(c.bin), (c) => binLevel(c.bin));
  if (best) {
    const extra = candidates.length > 1 ? ` (newest of ${candidates.length} installed copies)` : "";
    channel.appendLine(`pi-web entry (${best.leg}): ${best.bin}${extra}`);
    emitServerStatus("Starting local server…");
    return { mode: "bin", path: best.bin };
  }

  // 无兼容已装副本→现场安装最高兼容版本（managed 腿兜底）。
  emitServerStatus("Downloading and installing the server component (~540MB on disk, slower on first run)…");
  channel.appendLine(`managed runtime missing; running npm --prefix install…`);
  const installed = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "First run: downloading the Pi for IDE server runtime…",
    },
    (progress) =>
      installManagedPackage(channel, context, pkg, undefined, (msg) =>
        progress.report({ message: msg }),
      ),
  );
  const managedBinAfter = managedPackageBin(context, pkg, (l) => channel.appendLine(l));
  if (installed && managedBinAfter) {
    channel.appendLine(`pi-web entry (managed runtime): ${managedBinAfter}`);
    emitServerStatus("Starting local server…");
    return { mode: "bin", path: managedBinAfter };
  }
  channel.appendLine(`managed install failed (installed=${installed}) — no usable server entry.`);
  return undefined;
}
