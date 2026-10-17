import * as cp from "child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import * as net from "net";
import * as path from "path";
import * as vscode from "vscode";
import {
  EMBED_PROTOCOL_SUPPORTED,
  binLevel,
  installManagedPackage,
  levelSupported,
  managedPackageBin,
  queryRegistryCompat,
} from "./managedRuntime";

/**
 * 管理 pi-web 服务器的生命周期（独立进程）。
 *
 * pi-web 不打包进扩展，按以下顺序解析一个外部服务器入口：
 *   1. `"Pi for IDE.executablePath"` 配置（standalone 的 server.js 或包的 bin/pi-web.js）
 *   2. 扩展内置的 `resources/pi-web/server.js`（过渡期兼容；打包停止内置后自然消失）
 *   3. `npm root -g` 下已全局安装的 `"Pi for IDE.package"`（默认 @william_stone/pi-web-for-ide）
 *   4. PATH 上的 `pi-web-for-ide` shim（解析后校验包名，直启 bin 不走外壳）
 *   5. 扩展托管运行时（globalStorage/runtime 版本化目录，缺失则现场安装）
 *
 * 每条腿解析出的包都会校验其声明的桥接级别（piIde.level）是否在
 * 扩展支持区间 [MIN_PKG_LEVEL, EMBED_PROTOCOL_SUPPORTED] 内，
 * 不兼容则跳过该腿——版本布局/选择/安装/清理由 managedRuntime.ts 承担
 * （见 docs/agents/managed-runtime.md）。
 *
 * 服务器就绪后探测 `GET /api/embed`：返回 embed 协议标记说明是打过补丁的
 * pi-code web；404/异常说明接入了原版 pi-web（VSCode 集成功能不可用，提示
 * 用户更换安装源）。
 */

/** 默认起始端口：3030，被占用时自动 +1。 */
export const DEFAULT_PORT = 3030;

/**
 * 默认查询/安装的 npm 包名（含 embed 桥补丁的 pi-web 发行包）。
 * 可用 `"Pi for IDE.package"` 配置覆盖；置空则跳过全局安装兜底。
 */
const DEFAULT_PACKAGE = "@william_stone/pi-web-for-ide";

type SpawnTarget =
  /** node <server.js>——standalone 产物，只认 PORT/HOSTNAME 环境变量。 */
  | { mode: "script"; path: string }
  /** node <bin/pi-web.js>——npm 包入口，接受 --port/--hostname/--no-open。 */
  | { mode: "bin"; path: string };

/**
 * 探测从 startPort 开始的第一个空闲 TCP 端口（每次 +1，最多尝试 200 个）。
 */
/** 303x 端口占位者身份分类——决定诊断文案与是否可自动清理。 */
type OccupierKind = "legacy-npx" | "unscoped" | "upstream" | "ours" | "unknown";

interface PortOccupier {
  port: number;
  pid: number;
  cmdline: string;
  kind: OccupierKind;
}

/** 按命令行分类占位进程：_npx 残留 / 旧 unscoped 包 / 上游 pi-web / 本扩展系。 */
function classifyOccupier(cmd: string): OccupierKind {
  if (!/pi-web|standalone\\?server\.js/i.test(cmd)) return "unknown";
  if (/_npx[\\/]/i.test(cmd)) return "legacy-npx";
  if (/pi-web-for-ide/i.test(cmd)) {
    // 本扩展系：scoped 全局安装（路径含 william_stone）或托管运行时。
    if (/william_?stone|runtime[\\/]node_modules/i.test(cmd)) return "ours";
    return "unscoped";
  }
  return "upstream";
}

/**
 * 扫描 303x 端口上的监听者，解析 PID→命令行并分类。
 * 用途：启动时识别"另一个编辑器实例的旧包/上游/孤儿 pi-web 进程"——
 * 这类占位会导致新实例换端口、攥住 npx 缓存或让用户连到旧代码。
 */
async function scanPortOccupiers(from = 3030, to = 3039): Promise<PortOccupier[]> {
  const exec = (cmd: string, timeout = 10_000): Promise<string> =>
    new Promise((r) => cp.exec(cmd, { timeout }, (_e, out) => r(out)));
  // 1) 拿 303x 监听者的 port→pid 表。
  const listeners: { port: number; pid: number }[] = [];
  if (process.platform === "win32") {
    const out = await exec('netstat -ano | findstr "LISTENING" | findstr ":303"');
    for (const m of out.matchAll(/:(\d+)\s+[\d.:*]+\s+LISTENING\s+(\d+)/g)) {
      const port = Number(m[1]);
      if (port >= from && port <= to) listeners.push({ port, pid: Number(m[2]) });
    }
  } else {
    const out = await exec(
      `ss -tln 2>/dev/null | grep -oE ':30[0-9]{2} ' | tr -d ' :' | while read p; do
         fuser "$p"/tcp 2>/dev/null | xargs -r -n1 echo "$p"; done`,
    );
    for (const m of out.matchAll(/^(\d+)\s+(\d+)$/gm)) {
      listeners.push({ port: Number(m[1]), pid: Number(m[2]) });
    }
  }
  if (!listeners.length) return [];
  // 2) 批量取这些 pid 的命令行。
  const pids = [...new Set(listeners.map((l) => l.pid))];
  const cmdlines = new Map<number, string>();
  if (process.platform === "win32") {
    const ps = pids.map((p) => `,${p}`).join("");
    const out = await exec(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { @( ${ps.slice(1)} ) -contains $_.ProcessId } | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.CommandLine }"`,
      15_000,
    );
    for (const line of out.split(/\r?\n/)) {
      const i = line.indexOf("|");
      if (i > 0) cmdlines.set(Number(line.slice(0, i).trim()), line.slice(i + 1).trim());
    }
  } else {
    const out = await exec(`ps -o pid= -o command= -p ${pids.join(",")}`);
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (m) cmdlines.set(Number(m[1]), m[2]);
    }
  }
  return listeners.map((l) => {
    const cmdline = cmdlines.get(l.pid) ?? "";
    return { port: l.port, pid: l.pid, cmdline, kind: classifyOccupier(cmdline) };
  });
}

/** 启动时顺扫 303x：写生命周期/诊断日志；对可疑占位者（旧包/上游）给提示——
 *  不自动杀：那可能是用户有意运行的独立 pi-web 实例。 */
async function reportPortOccupiers(channel: vscode.OutputChannel): Promise<void> {
  try {
    const occupiers = await scanPortOccupiers();
    const suspicious = occupiers.filter((o) => o.kind === "unscoped" || o.kind === "upstream");
    for (const o of occupiers) {
      const short = o.cmdline.length > 140 ? "…" + o.cmdline.slice(-140) : o.cmdline;
      channel.appendLine(`port ${o.port} occupied by PID ${o.pid} [${o.kind}] ${short || "(no cmdline)"}`);
      logLifecycle(`port ${o.port} occupied by PID ${o.pid} [${o.kind}]`);
    }
    if (suspicious.length) {
      const list = suspicious.map((o) => `PID ${o.pid} (${o.kind === "unscoped" ? "legacy unscoped package" : "upstream pi-web"}, port ${o.port})`).join(", ");
      void vscode.window.showWarningMessage(
        `Pi for IDE: a likely stale pi-web process is running in another window/editor instance — ${list} (not this window). This instance switched to another port automatically. If it misbehaves, run "Pi for IDE: Stop Server" in that window, or kill it (taskkill /PID <pid> /T /F).`,
      );
    }
  } catch {
    // 扫描失败不阻断启动。
  }
}

function findFreePort(startPort: number): Promise<number> {
  return new Promise((resolve) => {
    const tryPort = (port: number, attempts = 0): void => {
      if (attempts >= 200) {
        // 兜底：让 OS 分配端口，避免无限探测。
        resolve(0);
        return;
      }
      const tester = net.createServer();
      tester.unref();
      tester.once("error", () => {
        try {
          tester.close();
        } catch {
          // 未监听，忽略。
        }
        tryPort(port + 1, attempts + 1);
      });
      tester.listen(port, "127.0.0.1", () => {
        tester.close(() => resolve(port));
      });
    };
    tryPort(startPort);
  });
}

/**
 * 用 `npm root -g` 找全局 node_modules，返回其中 `<pkg>/bin/pi-web.js`
 * 的绝对路径（不存在则 undefined）。npm 不在 PATH（如 nvm 未生效）时安静返回 undefined。
 */
function resolveGlobalPackageBin(pkg: string): Promise<string | undefined> {
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
async function resolvePathShimBin(
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


/** 过渡兜底：杀掉 _npx 缓存里残留的 pi-web 服务进程（下几个版本后移除）。
 * 历史版本 stop 只杀进程顶层，server.js 孤儿会攥住 _npx 缓存目录致后续
 * npx EBUSY——托管路径已不再用该缓存，这里只做存量清理。 */
export async function sweepLegacyOrphans(channel: vscode.OutputChannel): Promise<void> {
  const kill = (pid: number): void => {
    const cmd =
      process.platform === "win32"
        ? `taskkill /PID ${pid} /T /F`
        : `kill -TERM ${pid}`;
    cp.exec(cmd, { timeout: 10_000 }, (e, out) => {
      const merged = `${out}`;
      // 进程已退出/正被另一窗口终止是良性结果，不刷屏。
      if (!e || /cannot be|not found|不存在|不受支持|being terminated/i.test(merged + e.message)) {
        channel.appendLine(`orphan cleanup ${pid}: already exited or terminating${e ? " (benign)" : ""}`);
        return;
      }
      // 兜底：不经树杀，直接强杀该 PID。
      const fallback =
        process.platform === "win32"
          ? `powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force"`
          : `kill -9 ${pid}`;
      cp.exec(fallback, { timeout: 10_000 }, (e2) => {
        channel.appendLine(`orphan cleanup ${pid}: ${e2 ? "failed " + e2.message : "terminated"}`);
      });
    });
  };
  if (process.platform === "win32") {
    // 注意：整条命令被 cmd 包在双引号里执行，内部只能用单引号——嵌双引号
    // 会被 cmd 截断致 PowerShell 静默失败（曾致清扫空跑）。
    const ps =
      "Get-CimInstance Win32_Process " +
      "| Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match '_npx' -and $_.CommandLine -match 'pi-web|standalone' } " +
      "| Select-Object -ExpandProperty ProcessId";
    cp.exec(
      `powershell -NoProfile -Command "${ps}"`,
      { timeout: 15_000 },
      (e, out) => {
        if (e) return;
        for (const line of out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
          const pid = Number(line);
          if (pid > 0) kill(pid);
        }
      },
    );
    return;
  }
  cp.exec(
    `pgrep -f "npm-cache/_npx.*(pi-web|server\\.js)|_npx/.*/standalone/server\\.js"`,
    { timeout: 10_000 },
    (e, out) => {
      if (e) return;
      for (const line of out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        const pid = Number(line);
        if (pid > 0) kill(pid);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// 生命周期时间轴日志：关键事件带绝对时间戳写入"Pi for IDE 生命周期"频道，
// 便于把 UI 上看到的"空白→等待页→连接页→加载完成"与扩展内部时序对齐。
// ---------------------------------------------------------------------------
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

function emitServerStatus(text: string): void {
  lastServerStatus = text;
  logLifecycle(`stage: ${text}`);
  for (const cb of statusListeners) cb(text);
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
  const cmd = `${pm} i -g ${spec}`;
  channel.appendLine(`run: ${cmd}`);
  channel.show(true);
  return new Promise((resolve) => {
    const child = cp.spawn(cmd, { shell: true });
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
  const binPath =
    (await resolveGlobalPackageBin(pkg)) ?? (await resolvePathShimBin(pkg)) ?? managedBin;
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

export class PiIdeServer {
  context: vscode.ExtensionContext;
  child?: cp.ChildProcess;
  ready: Promise<string | undefined>;
  resolvedOrigin?: string;
  channel: vscode.OutputChannel;
  disposed = false;

  static ensureStarted(context: vscode.ExtensionContext): Promise<PiIdeServer | undefined> {
    const existing = (globalThis as Record<string, unknown>).__piIdeServer as PiIdeServer | undefined;
    if (existing && !existing.disposed) {
      logLifecycle(`ensureStarted: reusing running instance ${existing.resolvedOrigin ?? "(not ready)"}`);
      return Promise.resolve(existing);
    }
    logLifecycle("ensureStarted: new server instance");
    const server = new PiIdeServer(context);
    (globalThis as Record<string, unknown>).__piIdeServer = server;
    return server.start();
  }

  /** 进程停止/退出后清掉全局单例引用，下次 ensureStarted 才能重拉新进程。 */
  private clearGlobalIfSelf(): void {
    const g = globalThis as Record<string, unknown>;
    if (g.__piIdeServer === this) delete g.__piIdeServer;
  }

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.channel = outputChannel();
    this.ready = this.startProcess();
    this.ready.then((origin) => {
      if (origin) this.resolvedOrigin = origin;
    });
  }

  /** 解析后的 origin（如 `http://127.0.0.1:39211`）。启动完成前为 undefined。 */
  get origin(): string {
    return this.resolvedOrigin ?? "http://127.0.0.1:0";
  }

  async start(): Promise<this | undefined> {
    await this.ready;
    return this.resolvedOrigin ? this : undefined;
  }

  async stop(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.clearGlobalIfSelf();
    const child = this.child;
    if (!child || child.exitCode !== null || child.pid === undefined) return;
    // 杀整棵进程树，不是只杀顶层：npx/shell 包装链会留下孙进程
    // （server.js 孤儿继续监听端口并攥住缓存目录，曾致 npx EBUSY）。
    if (process.platform === "win32") {
      await new Promise<void>((r) =>
        cp.exec(`taskkill /PID ${child.pid} /T /F`, { timeout: 10_000 }, () => r()),
      );
    } else {
      try {
        // detached 子进程自成进程组：负 pid 杀整组。
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          // 尽力Close。
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // 启动
  // ------------------------------------------------------------------
  /** 解析并启动 pi-web 服务器，返回解析后的 origin。 */
  private async startProcess(): Promise<string | undefined> {
    let target = await this.resolveServerTarget();
    logLifecycle(target ? `resolved target: mode=${target.mode}` : "resolved target: all legs failed");
    // 阶段状态由 resolveServerTarget 各腿自报（managed 腿在 724/742 发
    // "Starting local server…"；下载腿先发 "Downloading…"再发 Starting）。
    // 不再这里统一补——双层发同一文案会重复。
    if (!target) {
      // 所有解析路径失败（含 npx）→ 引导用户全局安装，成功后重试一次。
      const pkg = this.packageName();
      this.channel.appendLine("No usable pi-web server found.");
      const pick = await vscode.window.showErrorMessage(
        `Pi for IDE cannot find a pi-web server. Install ${pkg} globally with one click, or install it yourself and retry.`,
        "Install",
        "Later",
      );
      if (pick !== "Install") return undefined;
      const ok = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Installing ${pkg}…` },
        () => installPiWebPackage(this.channel, pkg),
      );
      if (!ok) {
        void vscode.window.showErrorMessage(
          `${pkg} install failed — see the output panel (View → Output → Pi for IDE).`,
        );
        return undefined;
      }
      target = await this.resolveServerTarget();
      if (!target) {
        void vscode.window.showErrorMessage(
          `${pkg} installed but the entry still cannot be resolved; check the output log.`,
        );
        return undefined;
      }
    }
    const origin = await this.spawn(target);
    if (origin) await this.verifyEmbedSupport(origin);
    if (!origin) await this.reportStartupFailure(target);
    return origin;
  }

  /** 启动失败体检：把解析链各环节、环境、端口占用、npm 日志尾部写入
   *  输出面板并给出可操作的修复建议；最后弹"重试"按钮。 */
  private async reportStartupFailure(target: SpawnTarget): Promise<void> {
    const pkg = this.packageName();
    this.channel.appendLine("—— startup failure diagnostics ——");
    const tryCmd = (cmd: string): Promise<string> =>
      new Promise((r) =>
        cp.exec(cmd, { timeout: 8000 }, (e, out) =>
          r(e ? "unavailable" : out.trim().split("\n")[0] || "?"),
        ),
      );
    this.channel.appendLine(`node@PATH: ${await tryCmd("node -v")} (requires ≥ 22.19)`);
    this.channel.appendLine(`npm@PATH: ${await tryCmd("npm -v")}`);
    this.channel.appendLine(`pnpm@PATH: ${await tryCmd("pnpm -v")}`);

    // 解析链各环节现状——指出哪条腿能用、哪条断了。
    const configured = vscode.workspace
      .getConfiguration("Pi for IDE")
      .get<string>("executablePath")
      ?.trim();
    this.channel.appendLine(
      `resolve chain: executablePath=${configured ? (existsSync(configured) ? "exists" : "missing!") : "unset"}; ` +
        `global package=${(await resolveGlobalPackageBin(pkg)) ?? "not installed"}; ` +
        `shim=${(await resolvePathShimBin(pkg)) ?? "none"}; ` +
        `managed runtime=${managedPackageBin(this.context, pkg) ?? "missing"}; ` +
        `mode=${target.mode}`,
    );

    // 端口占用：3030-3039 谁在监听（含 PID/命令行/身份分类）。
    const occupiers = await scanPortOccupiers();
    if (!occupiers.length) {
      this.channel.appendLine("port 303x occupants: none");
    } else {
      for (const o of occupiers) {
        this.channel.appendLine(
          `port ${o.port}: PID ${o.pid} [${o.kind}] ${o.cmdline.slice(-140) || "(no cmdline)"}`,
        );
      }
    }

    // 最近一次 npm 日志尾部（npx/托管安装的 EBUSY 等真因都在里面）。
    const logsDir =
      process.platform === "win32"
        ? path.join(process.env.LOCALAPPDATA ?? "", "npm-cache", "_logs")
        : path.join(process.env.HOME ?? "", ".npm", "_logs");
    try {
      const latest = readdirSync(logsDir)
        .filter((f) => f.endsWith(".log"))
        .map((f) => ({ f, t: statSync(path.join(logsDir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)[0];
      if (latest && Date.now() - latest.t < 30 * 60_000) {
        const tail = readFileSync(path.join(logsDir, latest.f), "utf8")
          .split("\n")
          .filter((l) => /error|EBUSY|EPERM|EACCES|ENOENT/i.test(l))
          .slice(-15);
        if (tail.length) {
          this.channel.appendLine(`npm log ${latest.f} tail:\n  ${tail.join("\n  ")}`);
        }
      }
    } catch {
      // 无日志目录就算了。
    }

    this.channel.appendLine(
      "Suggestions: 1) read the log above for the root cause; 2) run \"Pi for IDE: Stop Server\" and retry; " +
        "3) install the package globally to skip the runtime download: pnpm add -g " + pkg + "@latest.",
    );

    const pick = await vscode.window.showErrorMessage(
      "Pi for IDE server failed to start; diagnostics were written to the output panel (Pi for IDE).",
      "View Output",
      "Stop && Retry",
      "Close",
    );
    if (pick === "View Output") this.channel.show(true);
    if (pick === "Stop && Retry") {
      // stop 标记 disposed → ensureStarted 会另起全新实例；走完整 open
      // 命令顺带把面板 refresh 到新地址。
      await this.stop();
      void vscode.commands.executeCommand("piIde.open");
    }
  }

  private packageName(): string {
    const config = vscode.workspace.getConfiguration("Pi for IDE");
    return (config.get<string>("package") ?? DEFAULT_PACKAGE).trim() || DEFAULT_PACKAGE;
  }

  /**
   * 按优先级解析服务器入口：
   *   executablePath → 内置 resources/pi-web/server.js → 全局 npm 包 → npx 兜底。
   */
  private async resolveServerTarget(): Promise<SpawnTarget | undefined> {
    const config = vscode.workspace.getConfiguration("Pi for IDE");

    // 1) 显式配置：接受 standalone server.js 或包内 bin/pi-web.js。
    const configured = config.get<string>("executablePath")?.trim();
    if (configured) {
      if (existsSync(configured)) {
        const target: SpawnTarget = path.basename(configured) === "server.js"
          ? { mode: "script", path: configured }
          : { mode: "bin", path: configured };
        this.channel.appendLine(`pi-web entry (configured): ${configured} [${target.mode}]`);
        return target;
      }
      this.channel.appendLine(`"Pi for IDE.executablePath" does not exist, ignored: ${configured}`);
    }

    // 2) 过渡期兼容：扩展内置的 standalone 产物（停止打包后该文件自然不存在）。
    const bundled = path.join(this.context.extensionPath, "resources", "pi-web", "server.js");
    if (existsSync(bundled)) {
      this.channel.appendLine(`pi-web entry (bundled): ${bundled}`);
      return { mode: "script", path: bundled };
    }

    // 级别校验：bin 所在包声明的桥接级别须在支持区间内，否则跳过该腿。
    const levelOk = (binPath: string, leg: string): boolean => {
      if (levelSupported(binLevel(binPath))) return true;
      this.channel.appendLine(
        `${leg} package level ${binLevel(binPath) ?? "unknown"} is outside the supported range, skipped.`,
      );
      return false;
    };

    // 3) 全局 npm 安装的发行包。
    const pkg = this.packageName();
    const globalBin = await resolveGlobalPackageBin(pkg);
    if (globalBin && levelOk(globalBin, "global install")) {
      this.channel.appendLine(`pi-web entry (global install): ${globalBin}`);
      return { mode: "bin", path: globalBin };
    }

    // 4) PATH 上的 pi-web shim（pnpm/yarn/bun 全局安装都会落这里；
    //    shim 脚本内含真实 bin/pi-web.js 路径，解析后仍走 node 直启，
    //    避免经 .cmd 外壳导致 stop 杀不死内层服务进程）。
    const shimBin = await resolvePathShimBin(pkg, (l) => this.channel.appendLine(l));
    if (shimBin && levelOk(shimBin, "PATH shim")) {
      this.channel.appendLine(`pi-web entry (PATH shim): ${shimBin}`);
      return { mode: "bin", path: shimBin };
    }

    // 5) 托管运行时：版本化目录 + marker 选择（见 managedRuntime.ts）；
    //    无兼容已装副本则现场安装最高兼容版本。
    const managedBin = managedPackageBin(this.context, pkg, (l) => this.channel.appendLine(l));
    if (managedBin) {
      this.channel.appendLine(`pi-web entry (managed runtime): ${managedBin}`);
      emitServerStatus("Starting local server…");
      return { mode: "bin", path: managedBin };
    }
    emitServerStatus("Downloading and installing the server component (~540MB on disk, slower on first run)…");
    this.channel.appendLine(`managed runtime missing; running npm --prefix install…`);
    const installed = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "First run: downloading the Pi for IDE server runtime…",
      },
      (progress) =>
        installManagedPackage(this.channel, this.context, pkg, undefined, (msg) =>
          progress.report({ message: msg }),
        ),
    );
    const managedBinAfter = managedPackageBin(this.context, pkg, (l) => this.channel.appendLine(l));
    if (installed && managedBinAfter) {
      this.channel.appendLine(`pi-web entry (managed runtime): ${managedBinAfter}`);
      emitServerStatus("Starting local server…");
      return { mode: "bin", path: managedBinAfter };
    }
    this.channel.appendLine(`managed install failed (installed=${installed}) — no usable server entry.`);
    return undefined;
  }

  /** 探测空闲端口后按目标模式启动服务器，等待 stdout 打印的 URL。 */
  private async spawn(target: SpawnTarget): Promise<string | undefined> {
    // 读取用户配置的起始端口（默认 3030），探测第一个空闲端口。
    const config = vscode.workspace.getConfiguration("Pi for IDE");
    const preferred =
      typeof config.get<number>("port") === "number"
        ? config.get<number>("port", DEFAULT_PORT)
        : DEFAULT_PORT;
    // 顺扫 303x 占位者：识别另一实例的旧包/上游/孤儿进程（日志+提示，不自动杀）。
    await reportPortOccupiers(this.channel);

    const port = await findFreePort(Math.max(1, preferred || DEFAULT_PORT));
    this.channel.appendLine(
      `Pi for IDE port probe: start ${preferred}, using ${port}${port === 0 ? " (OS-assigned)" : ""}`,
    );
    logLifecycle(`spawn: mode=${target.mode}, port=${port}`);

    // 双轨参数：env 供 standalone server.js；args 供 bin/npx 模式。
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      // bin 模式通过 PI_WEB_NO_OPEN 阻止 pi-web 自开浏览器（页面在扩展面板内）。
      PI_WEB_NO_OPEN: "1",
    };
    const launchArgs = ["--port", String(port), "--hostname", "127.0.0.1", "--no-open"];

    let command: string;
    let args: string[];
    switch (target.mode) {
      case "script":
        command = process.execPath;
        args = [target.path];
        break;
      case "bin":
        command = process.execPath;
        args = [target.path, ...launchArgs];
        break;
    }

    const readyTimeoutMs = 30_000;

    return new Promise((resolve) => {
      const child = cp.spawn(command, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        // POSIX 下独立进程组：stop() 时 kill(-pid) 杀整棵子进程树；
        // Windows 另用 taskkill /T /F（见 stop）。
        detached: process.platform !== "win32",
      });
      this.child = child;
      let readyLogged = false;
      const onLine = (line: string) => {
        this.channel.appendLine(line);
        // Next 启动会打印类似 `- Local: http://localhost:39211`，也可能
        // 打印 127.0.0.1。两种都识别。
        const match = line.match(/https?:\/\/(127\.0\.0\.1|localhost):\d+/);
        if (match && !readyLogged) {
          readyLogged = true;
          // 归一化成 127.0.0.1，避免 localhost 在严格 CSP 下出问题。
          const origin = match[0].replace("localhost", "127.0.0.1");
          logLifecycle(`spawn ready: origin=${origin}`);
          // 预热页面路由：Next 首次命中 `/` 才编译（约十秒级），提前触发让
          // 门页探测少等。
          void fetch(origin).catch(() => undefined);
          resolve(origin);
        }
      };
      let stdoutBuf = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        let idx;
        while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
          onLine(stdoutBuf.slice(0, idx));
          stdoutBuf = stdoutBuf.slice(idx + 1);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        this.channel.appendLine(chunk.toString());
      });
      child.on("error", (err) => {
        this.channel.appendLine(`Pi for IDE process failed to start: ${err.message}`);
        if (this.resolvedOrigin === undefined) resolve(undefined);
      });
      child.on("exit", (code) => {
        this.channel.appendLine(`Pi for IDE process exited with code ${code}`);
        // 进程死了（含意外崩溃）：标记并清全局，下次启动拉新进程。
        this.disposed = true;
        this.clearGlobalIfSelf();
        if (this.resolvedOrigin === undefined) resolve(undefined);
      });
      setTimeout(() => {
        if (this.resolvedOrigin === undefined) {
          this.channel.appendLine(`Pi for IDE start timed out (${readyTimeoutMs / 1000}s).`);
          resolve(undefined);
        }
      }, readyTimeoutMs);
    });
  }

  /**
   * 探测服务器的 embed 协议支持（GET /api/embed）。返回 404/异常说明接入的
   * 是原版 pi-web——VSCode 集成功能不可用，提示用户更换含补丁的发行包。
   * 非阻断：页面仍可浏览会话。
   */
  private async verifyEmbedSupport(origin: string): Promise<void> {
    // standalone 在 listen 成功时就打印 URL，但首请求还要懒加载路由，
    // 冷启动/杀软扫描下可能 30s+ 才真正可服务。探测分两态：
    //   连接层失败 → 仍在启动，继续等（窗口 90s）；
    //   拿到 HTTP 响应 → 立即判定：404=真原版，200+协议号=通过。
    const deadline = Date.now() + 90_000;
    let lastError = "no response";
    let gotHttpResponse = false;
    let saw5xx = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${origin}/api/embed`, { signal: AbortSignal.timeout(5000) });
        gotHttpResponse = true;
        if (res.status >= 500) saw5xx = true;
        const data = (await res.json().catch(() => null)) as
          | { embed?: { protocol?: number; version?: string } }
          | null;
        if (res.ok && data?.embed?.protocol) {
          this.channel.appendLine(
            `embed handshake OK: protocol v${data.embed.protocol}, server version ${data.embed.version ?? "unknown"}`,
          );
          logLifecycle(`embed handshake OK: protocol v${data.embed.protocol}, version ${data.embed.version ?? "unknown"}`);
          this.checkProtocolCompat(data.embed.protocol, data.embed.version);
          return;
        }
        if (res.status === 404) {
          lastError = "HTTP 404 (route missing)";
          break; // 服务器在跑但确实没有 embed 路由——原版，立即警告
        }
        lastError = `HTTP ${res.status}`;
      } catch (e) {
        lastError = String(e);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!gotHttpResponse) {
      this.channel.appendLine(`warning: no HTTP response from /api/embed within 90s (${lastError}) — the server may still be starting or has crashed.`);
      void vscode.window.showWarningMessage(
        "Pi for IDE: the server did not respond within 90s of starting. Check the spawn log in the output panel (Pi for IDE), or run \"Pi for IDE: Stop Server\" and retry.",
      );
      return;
    }
    // 5xx ≠ 原版：服务器在跑但路由抛错，多半是发行包安装不完整
    // （典型：pnpm/npm 拦了 postinstall，junction 未建）——提示重装/升级，
    // 而不是误报成"原版 pi-web"。
    if (saw5xx) {
      this.channel.appendLine(`warning: /api/embed returned ${lastError} — the server is running but the route failed; the package install may be incomplete.`);
      void vscode.window.showWarningMessage(
        `Pi for IDE: pi-web started but its API errors (${lastError}); the install may be incomplete. Reinstall: pnpm remove -g pi-web-for-ide && pnpm add -g ${this.packageName()}@latest, or check the output panel (Pi for IDE).`,
      );
      return;
    }
    this.channel.appendLine(`warning: /api/embed probe failed (${lastError}) — the connected pi-web may lack the embed bridge patch.`);
    void vscode.window.showWarningMessage(
      `Pi for IDE: the connected pi-web lacks IDE integration (likely upstream pi-web). Install the patched package: npm i -g ${this.packageName()}.`,
    );
  }

  /**
   * embed 协议兼容性检查。桥消息结构不兼容时按偏新的一侧给出升级指引：
   * 服务器协议高 → 升级扩展；服务器协议低 → 升级 @william_stone/pi-web-for-ide 包。
   * 警告而非硬阻断：会话浏览等基础功能在协议偏差下通常仍可用。
   */
  private checkProtocolCompat(protocol: number, serverVersion?: string): void {
    if (protocol === EMBED_PROTOCOL_SUPPORTED) return;
    const pkg = this.packageName();
    const ver = serverVersion ? ` v${serverVersion}` : "";
    if (protocol > EMBED_PROTOCOL_SUPPORTED) {
      void vscode.window.showWarningMessage(
        `pi-web${ver} uses embed protocol v${protocol}, newer than the supported v${EMBED_PROTOCOL_SUPPORTED}; IDE features may misbehave. Please upgrade the Pi for IDE extension.`,
      );
    } else {
      void vscode.window.showWarningMessage(
        `pi-web${ver} uses embed protocol v${protocol}, older than the supported v${EMBED_PROTOCOL_SUPPORTED}; IDE features may misbehave. Upgrade the package: npm i -g ${pkg}@latest.`,
      );
    }
    this.channel.appendLine(
      `embed protocol mismatch: server v${protocol} (${ver || "unknown version"}) vs extension-supported v${EMBED_PROTOCOL_SUPPORTED}`,
    );
  }
}
