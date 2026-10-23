import * as cp from "child_process";
import * as vscode from "vscode";
import { EMBED_PROTOCOL_SUPPORTED, managedRuntimeRoot } from "./managedRuntime";
import { DEFAULT_PACKAGE } from "./occupier";
import type { PortOccupier } from "./occupier";
import { reportStartupFailure } from "./diagnostics";
import { attachScanRange, findFreePort, reportPortOccupiers, scanPortOccupiers } from "./port-scan";
import {
  installPiWebPackage,
  resolveServerTarget,
} from "./server-resolve";
import type { SpawnTarget } from "./server-resolve";
import { logLifecycle, outputChannel } from "./server-status";
import {
  listSpawnBootRecords,
  recordSpawnBoot,
  writeInstanceMarker,
} from "./instance-coordination";
import { withServerLock } from "./server-lock";
import { piConfig } from "./config";

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

/** 本扩展宿主实例 id：心跳/shutdown 用它向服务端证明"谁在请求"——
 *  服务端据此拒绝"别窗还在用"的谋杀式关停（旧版宿主无 id 归匿名桶）。 */
const HOST_ID = crypto.randomUUID();

// 默认 npm 包名 DEFAULT_PACKAGE 与端口占位者分类在 ./occupier（纯模块）。
// 包名可用 `"Pi for IDE.package"` 配置覆盖。
// 端口扫描/孤儿清扫在 ./port-scan；解析链/包操作在 ./server-resolve；
// 启动体检在 ./diagnostics；输出频道与阶段状态总线在 ./server-status。

export class PiIdeServer {
  context: vscode.ExtensionContext;
  child?: cp.ChildProcess;
  ready: Promise<string | undefined>;
  resolvedOrigin?: string;
  channel: vscode.OutputChannel;
  disposed = false;
  /** 握手拿到的服务端可选特性表（capabilities map，见 embed-protocol.md）。 */
  embedCapabilities: Record<string, unknown> = {};
  /** 握手拿到的服务端进程实例标识（boot）——重启后必变，跨窗口换页判定用。 */
  embedBoot?: string;
  heartbeatTimer?: ReturnType<typeof setInterval>;

  static ensureStarted(context: vscode.ExtensionContext): Promise<PiIdeServer | undefined> {
    const existing = (globalThis as Record<string, unknown>).__piIdeServer as PiIdeServer | undefined;
    if (existing && !existing.disposed) {
      logLifecycle(`ensureStarted: reusing running instance ${existing.resolvedOrigin ?? "(not ready)"}`);
      // 必须 await ready：在途实例的 resolvedOrigin 还是 undefined，直接
      // 返回会让 serverReady 带上哨兵 origin :0，shell 探到死。
      return existing.start();
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
    // 本宿主拉起的新实例就绪后落「当前实例」标记（attach 来的不写——
    // 标记语义是"最新 spawn"，见 instance-coordination.ts）。
    if (this.resolvedOrigin && this.child) {
      writeInstanceMarker(
        managedRuntimeRoot(this.context),
        { boot: this.embedBoot, origin: this.resolvedOrigin },
        this.channel,
      );
    }
    return this.resolvedOrigin ? this : undefined;
  }

  async stop(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.clearGlobalIfSelf();
    this.stopHeartbeat();
    const child = this.child;
    if (!child || child.exitCode !== null || child.pid === undefined) {
      // 接入来的服务器不持有进程句柄；声明 lifecycle.shutdown 时让服务端
      // 自行优雅退出（共享服务器的正确关法），老服务器则无法停。
      // 服务端收权：有别的心跳客户端（含旧版匿名宿主）→ 409，要 force 重试。
      if (this.resolvedOrigin && this.embedCapabilities["lifecycle.shutdown"]) {
        try {
          const post = (force: boolean) =>
            fetch(`${this.resolvedOrigin}/api/embed/shutdown`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ client: HOST_ID, force }),
              signal: AbortSignal.timeout(5_000),
            });
          let res = await post(false);
          if (res.status === 409) {
            const { clients } = (await res.json().catch(() => ({}))) as { clients?: number };
            const n = clients && clients > 0 ? clients : 1;
            const pick = await vscode.window.showWarningMessage(
              `The shared pi-web server is also used by ${n} other window(s). Stop it anyway?`,
              { modal: true },
              "Stop Anyway",
            );
            if (pick !== "Stop Anyway") {
              this.channel.appendLine("shared-server stop canceled — still in use by other windows.");
              return;
            }
            res = await post(true);
          }
          if (res.ok) {
            this.channel.appendLine("asked the shared server to shut down (lifecycle.shutdown).");
          }
        } catch {
          // 已经不在了。
        }
      }
      return;
    }
    // 杀整棵进程树，不是只杀顶层：npx/shell 包装链会留下孙进程
    // （server.js 孤儿继续监听端口并攥住缓存目录，曾致 npx EBUSY）。
    if (process.platform === "win32") {
      await new Promise<void>((r) =>
        cp.exec(`taskkill /PID ${child.pid} /T /F`, { timeout: 10_000, windowsHide: true }, () => r()),
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

  /**
   * 扩展宿主退出路径（deactivate）：停心跳=离场，一律不杀进程——服务器
   * 主权在 web 侧（watchdog 收割静默），老服务器没 watchdog 就留作孤儿：
   * 下个窗口的 attach 会复用它（放不下也比"误杀共享服务器"安全——另一
   * 窗口可能正接着它跑）。要关停走 "Pi for IDE: Stop Server" 显式命令。
   */
  release(): void {
    this.stopHeartbeat();
    this.disposed = true;
    this.clearGlobalIfSelf();
  }

  /** 服务器声明 lifecycle.heartbeat 时每 15s 报存在；失败静默重试，
   *  只在首次失败记一条日志（服务器忙/重启中不该刷屏）。 */
  private startHeartbeat(): void {
    if (!this.embedCapabilities["lifecycle.heartbeat"] || this.heartbeatTimer) return;
    let failures = 0;
    this.heartbeatTimer = setInterval(() => {
      const origin = this.resolvedOrigin;
      if (!origin) return;
      fetch(`${origin}/api/embed/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client: HOST_ID }),
        signal: AbortSignal.timeout(5_000),
      })
        .then(() => {
          failures = 0;
        })
        .catch(() => {
          if (++failures === 1) {
            this.channel.appendLine("embed heartbeat failed — will keep retrying silently.");
          }
        });
    }, 15_000);
    (this.heartbeatTimer as NodeJS.Timeout).unref?.();
    this.channel.appendLine("embed heartbeat armed (15s interval).");
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  // ------------------------------------------------------------------
  // 启动
  // ------------------------------------------------------------------
  /** 解析并启动 pi-web 服务器，返回解析后的 origin。 */
  private async startProcess(allowInstallPrompt = true): Promise<string | undefined> {
    // 临界区入锁：跨窗口同时只一个执行者做 attach→resolve→spawn 决策。
    // 先扫 ours 端口再进解析：另一窗口/扩展宿主重启留下的孤儿在跑时直接
    // 接入，省掉整条解析链（尤其 managed 腿缺失时那一次 ~540MB 的安装）。
    // 锁内 spawn 会等到监听就绪才返回——后到窗口的 attach 接到的是已就绪
    // 实例，"端口已绑但 API 未就绪"的竞态窗口随之闭合。
    const core = await withServerLock(
      "ensure-started",
      async (): Promise<{ origin?: string; target?: SpawnTarget; needInstall?: boolean }> => {
        const attached = await this.attachToRunningServer(3_000);
        if (attached) return { origin: attached };
        const target = await resolveServerTarget(this.context, this.channel, this.packageName());
        logLifecycle(target ? `resolved target: mode=${target.mode}` : "resolved target: all legs failed");
        if (!target) return { needInstall: true };
        // spawn 失败也可能就是撞口竞态：对方在 probe→spawn 间隙绑定。三级降级：
        // ① attach 到赢家（30s 窗口等它就绪）② attach 也不行且赢家不是本系
        // 实例（standalone/无关服务，永远无法服务我们）才换口重 spawn——
        // ours 实例在跑时绝不复制第二份：两实例读写同一 ~/.pi 状态目录会互踩。
        const origin = (await this.spawn(target))
          ?? (await this.attachToRunningServer(30_000))
          ?? (await this.spawnUnlessOursOccupier(target));
        return { origin, target };
      },
      undefined,
      this.channel,
    );

    // 交互式安装腿在锁外——用户思考时间不占跨窗口互斥。装完重进锁走完整
    // 流程（此时另一窗口若已就绪，attach 扫描会先命中）。
    if (core.needInstall) {
      if (!allowInstallPrompt) {
        void vscode.window.showErrorMessage(
          `${this.packageName()} installed but the entry still cannot be resolved; check the output log.`,
        );
        return undefined;
      }
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
      return this.startProcess(false);
    }

    const { origin, target } = core;
    if (origin) {
      await this.verifyEmbedSupport(origin);
      this.startHeartbeat();
    }
    if (!origin) await reportStartupFailure(this.channel, this.context, this.packageName(), target);
    return origin;
  }

  /**
   * 撞口竞态的最后一腿：赢家不是本系实例（standalone/无关服务）才换口重
   * spawn。若 303x 上已有 ours 实例（哪怕暂时没就绪——冷启 JIT 中），
   * 就放弃让上层报启动失败：复制第二份 ours 实例既浪费内存，两个进程
   * 读写同一 ~/.pi 状态目录更会互相踩（run-records/ui-state/快照）。
   */
  private async spawnUnlessOursOccupier(target: SpawnTarget): Promise<string | undefined> {
    // cmdline 分类会漏（junction 回仓库、目录名不含包名等）：对所有
    // pi-web 形态的占用者再做一次握手兜底，响应者无论归哪类都是自己人。
    const cands = (await scanPortOccupiers(attachScanRange().from, attachScanRange().to, this.packageName()))
      .filter((o) => o.kind !== "unknown");
    for (const o of cands) {
      const origin = await this.tryAttach(o);
      if (origin) return origin;
    }
    const ours = cands.filter((o) => o.kind === "ours");
    if (ours.length) {
      logLifecycle(
        `port race lost to our instance on :${ours.map((o) => o.port).join("/")} — not spawning a duplicate; retry after it finishes starting.`,
      );
      return undefined;
    }
    logLifecycle("port race lost to a foreign occupier — retrying spawn on a fresh port");
    return this.spawn(target);
  }

  private packageName(): string {
    const config = piConfig();
    return (config.get<string>("package") ?? DEFAULT_PACKAGE).trim() || DEFAULT_PACKAGE;
  }

  /**
   * 接入 303x 上已在跑的本扩展系服务器（kind==="ours" 的 managed/global
   * 安装进程——另一窗口或扩展宿主重启留下的孤儿）。逐端口试 embed 握手；
   * graceMs 内它还在启动（尚未监听）就轮询等到其就绪或超时。
   * 是"接入"不是"接管"：服务器主权归它自己（watchdog 判生死），本侧只是
   * 注册存在；this.child 保持 undefined，stop() 不杀非本实例拉起的进程。
   */
  private async attachToRunningServer(graceMs: number): Promise<string | undefined> {
    let deadline = Date.now() + graceMs;
    let waitLogged = false;
    let bootWaitLogged = false;
    do {
      // 候选 = 所有 pi-web 形态占用者（kind !== "unknown"）：embed 握手
      // 本身即身份证明，cmdline 分类只供文案——junction/dev 路径常被误判。
      const cands = (await scanPortOccupiers(attachScanRange().from, attachScanRange().to, this.packageName())).filter((o) => o.kind !== "unknown");
      // 启动窗口记录补盲：兄弟窗口 spawn→bind 之间端口扫描全空，但记录
      // 带着目标端口——合成伪占用者交给同一个 tryAttach 握手路径。
      const bound = new Set(cands.map((o) => o.port));
      const booting = listSpawnBootRecords()
        .filter((b) => !bound.has(b.port))
        .map((b) => ({ port: b.port, pid: b.pid, cmdline: "ide-spawn record", kind: "ours" as const }));
      const all = [...cands, ...booting];
      if (!all.length && !waitLogged && !bootWaitLogged) return undefined;
      // 冷启 JIT 下 spawn→就绪可达几十秒：只看到启动记录（端口还没影）
      // 时把等待窗拉长——这正是重复 spawn 最容易钻进去的空档。
      if (booting.length && !cands.length && !bootWaitLogged) {
        bootWaitLogged = true;
        deadline = Math.max(deadline, Date.now() + 60_000);
        this.channel.appendLine(
          `pi-web spawn in progress on :${booting.map((o) => o.port).join("/")} — waiting for it to come up…`,
        );
      }
      for (const o of all) {
        const origin = await this.tryAttach(o);
        if (origin) return origin;
      }
      if (all.length && !waitLogged) {
        waitLogged = true;
        this.channel.appendLine(
          `pi-web on :${all.map((o) => o.port).join("/")} is still starting — waiting to attach…`,
        );
      }
      if (Date.now() < deadline) await new Promise((r) => setTimeout(r, 2_000));
    } while (Date.now() < deadline);
    return undefined;
  }

  /** 对单个占用者试 embed 握手；响应即证明是本扩展系实例 → attach。 */
  private async tryAttach(o: PortOccupier): Promise<string | undefined> {
    const origin = `http://127.0.0.1:${o.port}`;
    let identity = "";
    try {
      const res = await fetch(`${origin}/api/embed`, { signal: AbortSignal.timeout(4_000) });
      if (!res.ok) return undefined;
      // 握手体带出"这是哪一份"：同版本不同 build/不同安装根在 version
      // 字段上不可区分——attach 日志必须能回答它。
      const body = (await res.json()) as {
        embed?: { version?: string; builtAt?: string; gitSha?: string; installRoot?: string };
      };
      const e = body.embed ?? {};
      identity = [
        e.version ? `v${e.version}` : "",
        e.builtAt ? `built ${e.builtAt}` : "",
        e.gitSha ? `(${e.gitSha})` : "",
        e.installRoot ?? "",
      ].filter(Boolean).join(" ");
    } catch {
      return undefined;
    }
    this.channel.appendLine(
      `attached to running Pi Web server on :${o.port} (PID ${o.pid})${identity ? ` — ${identity}` : ""} — skipping duplicate spawn.`,
    );
    logLifecycle(`attached: origin=${origin}, pid=${o.pid}, kind=${o.kind}, ${identity}`);
    // attach 只扫 303x——用户显式配置了别的起始端口时，接上的实例
    // 可能不是他们以为的那份（别的窗口/手动起的）。给个可见提示，
    // 让"配了端口却连上旧实例"不再静默。
    const preferred = piConfig()
      .get<number>("port", DEFAULT_PORT);
    if (preferred !== o.port) {
      void vscode.window.showInformationMessage(
        `Pi for IDE attached to a running server on :${o.port} (configured port ${preferred}). It shares its session/agent data with whoever started it.`,
      );
    }
    return origin;
  }

  /** 探测空闲端口后按目标模式启动服务器，等待 stdout 打印的 URL。 */
  private async spawn(target: SpawnTarget): Promise<string | undefined> {
    // 读取用户配置的起始端口（默认 3030），探测第一个空闲端口。
    const config = piConfig();
    const preferred =
      typeof config.get<number>("port") === "number"
        ? config.get<number>("port", DEFAULT_PORT)
        : DEFAULT_PORT;
    // 顺扫 303x 占位者：识别另一实例的旧包/上游/孤儿进程（日志+提示，不自动杀）。
    await reportPortOccupiers(this.channel, this.packageName());

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
    // 生命周期主权在服务器侧：autoStop 开 → 注入 watchdog 旗标，服务器在
    // 全静默（无心跳无开着的客户端）超时后自行退出。独立启动的实例无旗标。
    const autoStop = config.get<boolean>("autoStop", true);
    // 下限 90s：心跳 15s×6（丢几拍不误杀），也留足后台页轮询被浏览器
    // 限流到 ~60s 的缺口——低于此值隐藏标签页可能保不住服务器。
    const autoStopAfterSec = Math.max(90, config.get<number>("autoStopAfterSec", 90) || 90);
    if (autoStop) {
      env.PI_WEB_EMBED_WATCHDOG = "1";
      env.PI_WEB_EMBED_WATCHDOG_TIMEOUT_SEC = String(autoStopAfterSec);
    }

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
        // GUI 宿主下不弹黑色控制台窗口（npm/pi-web 子进程同理）。
        windowsHide: true,
      });
      this.child = child;
      // 启动窗口记录：spawn→bind 之间端口扫描全盲，兄弟窗口凭记录
      // attach-等而不是重复 spawn（协议见 instance-coordination.ts）。
      const dropBootRecord = recordSpawnBoot(child.pid, port);
      let readyLogged = false;
      const onLine = (line: string) => {
        this.channel.appendLine(line);
        // Next 启动会打印类似 `- Local: http://localhost:39211`，也可能
        // 打印 127.0.0.1。两种都识别。
        const match = line.match(/https?:\/\/(127\.0\.0\.1|localhost):\d+/);
        if (match && !readyLogged) {
          readyLogged = true;
          dropBootRecord(); // 已监听——端口扫描接管，记录使命完成
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
        dropBootRecord();
        this.channel.appendLine(`Pi for IDE process failed to start: ${err.message}`);
        if (this.resolvedOrigin === undefined) resolve(undefined);
      });
      child.on("exit", (code) => {
        dropBootRecord();
        this.channel.appendLine(`Pi for IDE process exited with code ${code}`);
        // 进程死了（含意外崩溃）：标记并清全局，下次启动拉新进程。
        this.disposed = true;
        this.clearGlobalIfSelf();
        if (this.resolvedOrigin === undefined) resolve(undefined);
      });
      setTimeout(() => {
        // 判据是"URL 打没打出来"（本 promise 的 resolve 条件），不是
        // resolvedOrigin——那要握手才设，spawn 成功后会误报超时。
        if (!readyLogged) {
          dropBootRecord();
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
          | { embed?: { protocol?: number; version?: string; boot?: string; capabilities?: Record<string, unknown> } }
          | null;
        if (res.ok && data?.embed?.protocol) {
          this.embedCapabilities = data.embed.capabilities ?? {};
          this.embedBoot = data.embed.boot;
          this.channel.appendLine(
            `embed handshake OK: protocol v${data.embed.protocol}, server version ${data.embed.version ?? "unknown"}` +
              `, capabilities: ${Object.keys(this.embedCapabilities).join(", ") || "none"}`,
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
