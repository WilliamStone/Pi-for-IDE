import * as cp from "child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "fs";
import * as net from "net";
import * as path from "path";
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
import { emitServerStatus, logLifecycle, outputChannel } from "./server-status";
import {
  listSpawnBootRecords,
  readInstanceMarker,
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
  /** 本实例拉起的服务器进程 pid——POSIX 是 child.pid，Windows 是 WMI
   *  间接创建的 cmd 包装（node 为其子孙，taskkill /T 语义相同）。
   *  attach 来的保持 undefined——stop() 据此区分"能杀"与"只能求它停"。 */
  private ownedPid?: number;
  /** Windows-WMI 路径的 log 尾读 + 存活巡检定时器（child.on('exit') 的替身）。 */
  private spawnWatchTimer?: ReturnType<typeof setInterval>;
  ready: Promise<string | undefined>;
  resolvedOrigin?: string;
  /** 服务已绑口、origin 已知但 embed 握手可能在途——sessions 清单等只读
   *  端点（/api/sessions 独立路由，不等握手）可以抢先使用。 */
  boundOrigin?: string;
  channel: vscode.OutputChannel;
  disposed = false;
  /** startProcess 在途（attach/resolve/spawn 任一阶段）——UI 态用。 */
  private booting = true;
  /** 握手拿到的服务端可选特性表（capabilities map，见 embed-protocol.md）。 */
  embedCapabilities: Record<string, unknown> = {};
  /** 握手拿到的服务端进程实例标识（boot）——重启后必变，跨窗口换页判定用。 */
  embedBoot?: string;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  /** 心跳失败后的确认探测在途——同一时刻只允许一个，防 15s tick 叠加。 */
  private goneProbing?: boolean;

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
    this.ready.then(
      (origin) => {
        if (origin) this.resolvedOrigin = origin;
        this.booting = false;
      },
      () => {
        this.booting = false;
      },
    );
  }

  /**
   * 树/面板区分 "未启动" 与 "解析/启动进行中"——ready 在途即启动中。
   * 跨窗口语义：只读本窗自己的启动进程；别窗 spawn 在跑而本窗还没进
   * 临界区时仍报未启动（ attach 扫描是临界区内的第一步 ）。
   */
  static starting(): boolean {
    const s = (globalThis as Record<string, unknown>).__piIdeServer as PiIdeServer | undefined;
    return Boolean(s && !s.disposed && s.booting);
  }

  /** 同步读当前实例（不等 ready）——sessions 轮询要抢在握手完成前拿
   *  boundOrigin，await ensureStarted 会把清单钉死在握手之后。 */
  static peek(): PiIdeServer | undefined {
    const s = (globalThis as Record<string, unknown>).__piIdeServer as PiIdeServer | undefined;
    return s && !s.disposed ? s : undefined;
  }

  /** 解析后的 origin（如 `http://127.0.0.1:39211`）。启动完成前为 undefined。 */
  get origin(): string {
    return this.resolvedOrigin ?? "http://127.0.0.1:0";
  }

  async start(): Promise<this | undefined> {
    await this.ready;
    // 本宿主拉起的新实例就绪后落「当前实例」标记（attach 来的不写——
    // 标记语义是"最新 spawn"，见 instance-coordination.ts）。
    if (this.resolvedOrigin && this.ownedPid !== undefined) {
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
    this.clearSpawnWatch();
    // 归属判据统一走 ownedPid（POSIX child.pid / Windows WMI cmd pid）；
    // POSIX 侧 child 已知退出时 ownedPid 形同虚设——跟"接入来的"一样走
    // 关停请求而非杀进程（进程已死，杀了也只会报"找不到"）。Windows-WMI
    // 侧的死亡由 spawnWatch 巡检置 disposed，到不了这里。
    const child = this.child;
    const ownedLive =
      this.ownedPid !== undefined &&
      (process.platform === "win32" || child === undefined || child.exitCode === null);
    if (!ownedLive) {
      // 接入来的服务器不持有进程句柄；声明 lifecycle.shutdown 时让服务端
      // 自行优雅退出（共享服务器的正确关法），老服务器则无法停。
      // 服务端收权：有别的心跳客户端（含旧版匿名宿主）→ 409，要 force 重试。
      const origin = this.resolvedOrigin;
      if (origin && this.embedCapabilities["lifecycle.shutdown"]) {
        try {
          const post = (force: boolean) =>
            fetch(`${origin}/api/embed/shutdown`, {
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
            // 服务端确认后还要 ~500ms 冲洗窗口才退：等它真释放端口再
            // 返回——否则紧随的 ensureServer()（升级流程的 restart 腿）
            // 会把将死实例 attach 回来，接回来它才死，留下永远 running
            // 的死引用。超时兜底：不阻塞调用方语义。
            if (!(await this.waitForServerGone(origin, 10_000))) {
              this.channel.appendLine(
                "shutdown acknowledged but the port is still bound after 10s — continuing anyway.",
              );
            }
          }
        } catch {
          // 已经不在了。
        }
      }
      return;
    }
    // 杀整棵进程树，不是只杀顶层：npx/shell 包装链会留下孙进程
    // （server.js 孤儿继续监听端口并攥住缓存目录，曾致 npx EBUSY）。
    // Windows 下 ownedPid 是 WMI 拉起的 cmd 壳，/T 连子孙 node 一起清。
    const pid = this.ownedPid;
    if (process.platform === "win32") {
      await new Promise<void>((r) =>
        cp.exec(`taskkill /PID ${pid} /T /F`, { timeout: 10_000, windowsHide: true }, () => r()),
      );
    } else {
      try {
        // detached 子进程自成进程组：负 pid 杀整组。
        process.kill(-(pid as number), "SIGTERM");
      } catch {
        try {
          process.kill(pid as number, "SIGTERM");
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
    this.clearSpawnWatch();
    this.disposed = true;
    this.clearGlobalIfSelf();
  }

  private clearSpawnWatch(): void {
    if (this.spawnWatchTimer) {
      clearInterval(this.spawnWatchTimer);
      this.spawnWatchTimer = undefined;
    }
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
          void this.noteHeartbeatMiss(origin);
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

  /**
   * attach 来的实例（ownedPid 为空）没有进程句柄可巡检：心跳失败即对
   * /api/embed 做一次确认探测——探不通才判死释放引用，此后 peek() 返空
   * （树回到 not-running）、下一个真实 ensureStarted 重走 attach→spawn
   * 换新实例。owned 实例不在这里判：pid 巡检能区分"进程死了"与"活着但
   * HTTP 挂"，HTTP 探测分不出后者，归 spawnWatch/exit 管。
   */
  private async noteHeartbeatMiss(origin: string): Promise<void> {
    if (this.ownedPid !== undefined || this.disposed || this.goneProbing) return;
    this.goneProbing = true;
    try {
      await fetch(`${origin}/api/embed`, { signal: AbortSignal.timeout(4_000) });
    } catch {
      this.markAttachedServerGone(origin);
    } finally {
      this.goneProbing = false;
    }
  }

  /** attach 来的服务器确认已死：释放引用，本实例从此不再被复用
   *  （与 release() 同语义——不杀进程，只丢本地引用）。 */
  private markAttachedServerGone(origin: string): void {
    if (this.disposed) return;
    this.channel.appendLine(
      `server at ${origin} is gone — released the attached instance; next use re-resolves.`,
    );
    this.release();
  }

  /** 等 origin 的端口停止接受 TCP 连接——"服务器真退了"才返回 true；
   *  超时 false，调用方记日志后继续（不阻塞关停语义）。 */
  private async waitForServerGone(origin: string, timeoutMs: number): Promise<boolean> {
    const port = Number(new URL(origin).port || 0);
    if (!port) return true;
    const deadline = Date.now() + timeoutMs;
    do {
      const bound = await new Promise<boolean>((resolve) => {
        const sock = net.connect(port, "127.0.0.1");
        sock.setTimeout(500);
        const done = (ok: boolean) => {
          sock.destroy();
          resolve(ok);
        };
        sock.once("connect", () => done(true));
        sock.once("timeout", () => done(false));
        sock.once("error", () => done(false));
      });
      if (!bound) return true;
      await new Promise((r) => setTimeout(r, 250));
    } while (Date.now() < deadline);
    return false;
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
        emitServerStatus("Checking for a running server…");
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
      // 先记下 boundOrigin：sessions 树的下一次拉取（状态广播触发的
      // 即时补拍）可抢在 verifyEmbedSupport 懒加载期间出清单。
      this.boundOrigin = origin;
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
      // attach 判定只需要"端口绑没绑"——TCP connect 探测与 netstat 同
      // 语义（绑了但懒加载中的服务器也命中，HTTP 探测会漏），并发一轮
      // ~0.5s、零子进程，替掉 netstat+PowerShell 的重量级扫描
      // （Windows+杀软下每次数秒到十几秒，曾是冷启大头）。
      const cands = await this.probeAttachPorts();
      // 启动窗口记录补盲：兄弟窗口 spawn→bind 之间端口扫描全空，但记录
      // 带着目标端口——合成伪占用者交给同一个 tryAttach 握手路径。
      const bound = new Set(cands.map((o) => o.port));
      const booting = listSpawnBootRecords()
        .filter((b) => !bound.has(b.port))
        .map((b) => ({ port: b.port, pid: b.pid, cmdline: "ide-spawn record", kind: "ours" as const }));
      const all = [...cands, ...booting];
      // 实例标记记着"本宿主上次拉起/接入的实例"——EH 重启/重载后要接回的
      // 就是它；端口落在扫描范围外（配了别的起始端口/范围没盖到）时这是
      // 唯一的接回线索。端口没绑也只多一次毫秒级失败握手。
      let markerPort = 0;
      try {
        markerPort = Number(
          new URL(readInstanceMarker(managedRuntimeRoot(this.context))?.origin ?? "").port || 0,
        );
      } catch {
        // 标记文件半截/非 URL——按无候选处理。
      }
      if (markerPort && !bound.has(markerPort) && !booting.some((b) => b.port === markerPort)) {
        all.push({ port: markerPort, pid: 0, cmdline: "instance marker", kind: "ours" });
      }
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
      // 候选间无依赖（只读握手）——并发后最坏耗时仍是单次超时量级；串行
      // 会让"绑口但不答"的僵尸堆积把启动拖成 N×4s 的静默卡死，攥着跨窗
      // 锁把 EH 拖到被判无响应（e2e 残留 WMI 孤儿实证：10 端口 ~40s）。
      const hits = await Promise.all(all.map((o) => this.tryAttach(o)));
      const origin = hits.find((o): o is string => !!o);
      if (origin) return origin;
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

  /** 对扫描范围各端口并发 TCP connect——绑定即"有进程在听"（懒加载中
   *  也命中），交给 tryAttach 的 embed 握手裁决是否本系实例。pid 未知
   *  填 0（日志以 ? 呈现）。 */
  private async probeAttachPorts(): Promise<PortOccupier[]> {
    const { from, to } = attachScanRange();
    const bound = (port: number) =>
      new Promise<boolean>((resolve) => {
        const sock = net.connect(port, "127.0.0.1");
        sock.setTimeout(600);
        const done = (ok: boolean) => {
          sock.destroy();
          resolve(ok);
        };
        sock.once("connect", () => done(true));
        sock.once("timeout", () => done(false));
        sock.once("error", () => done(false));
      });
    const probes = await Promise.all(
      Array.from({ length: to - from + 1 }, (_, i) => from + i).map(
        async (port): Promise<PortOccupier | undefined> =>
          (await bound(port))
            ? { port, pid: 0, cmdline: "tcp probe", kind: "ours" }
            : undefined,
      ),
    );
    return probes.filter((p): p is PortOccupier => !!p);
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
      `attached to running Pi Web server on :${o.port}${o.pid ? ` (PID ${o.pid})` : ""}${identity ? ` — ${identity}` : ""} — skipping duplicate spawn.`,
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
    emitServerStatus("Starting the server process…");
    // 读取用户配置的起始端口（默认 3030），探测第一个空闲端口。
    const config = piConfig();
    const preferred =
      typeof config.get<number>("port") === "number"
        ? config.get<number>("port", DEFAULT_PORT)
        : DEFAULT_PORT;
    // 顺扫 303x 占位者（netstat+PowerShell，Windows 下十几秒级）——纯诊断
    // 输出，后台跑不占启动临界路径；可疑占位仍照常提示。
    void reportPortOccupiers(this.channel, this.packageName());

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
      // V8 编译缓存目录（epipe-guard 读取）：globalStorage 下持久化，
      // server bundle 的编译产物跨 spawn 复用，削减冷启里的大头开销。
      PI_IDE_COMPILE_CACHE: path.join(
        this.context.globalStorageUri.fsPath,
        "compile-cache",
      ),
    };
    const launchArgs = ["--port", String(port), "--hostname", "127.0.0.1", "--no-open"];
    // 生命周期主权在服务器侧：autoStop 开 → 注入 watchdog 旗标，服务器在
    // 全静默（无心跳无开着的客户端）超时后自行退出。独立启动的实例无旗标。
    const autoStop = config.get<boolean>("autoStop", true);
    // 下限 90s：心跳 15s×6（丢几拍不误杀），也留足后台页轮询被浏览器
    // 限流到 ~60s 的缺口——低于此值隐藏标签页可能保不住服务器。
    // 默认 300s：窗口重载/宿主重启的常见空窗（<5min）内服务器不被收割，
    // attach 直接接管免冷启；真没人要的孤儿仍会被回收。下限 90s 不变。
    const autoStopAfterSec = Math.max(90, config.get<number>("autoStopAfterSec", 300) || 300);
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

    // 管道死亡防护：宿主退出后子进程下一次日志写会撞 EPIPE 崩溃——
    // --require 预载守卫只吞管道错误，让孤儿服务器活到被重新 attach
    // （文件缺失时降级为不注入，spawn 照常）。node 旗标须在脚本路径之前。
    const epipeGuard = path.join(this.context.extensionPath, "out", "epipe-guard.js");
    const nodeArgs = existsSync(epipeGuard) ? ["--require", epipeGuard] : [];
    args = [...nodeArgs, ...args];

    const readyTimeoutMs = 30_000;

    // Windows：cp.spawn 的子进程挂进扩展宿主所在 Job Object（Chromium 给
    // utility 进程套的 KILL_ON_CLOSE job，成员身份随创建继承——宿主死亡/
    // 窗口重载时整锅陪葬，detached 旗标逃不出 job）。要让服务器在宿主死
    // 后存活，必须由 job 外进程创建——经 WMI Win32_Process.Create（创建者
    // WmiPrvSE 不在 job 内），stdout 落盘由本侧尾读。POSIX 无此问题：
    // detached 自成进程组，宿主信号都追不上。
    if (process.platform === "win32") {
      return this.spawnViaWmi(command, args, env, port, readyTimeoutMs);
    }

    return new Promise((resolve) => {
      const child = cp.spawn(command, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        // POSIX 下独立进程组：stop() 时 kill(-pid) 杀整棵子进程树。
        detached: true,
        // GUI 宿主下不弹黑色控制台窗口（npm/pi-web 子进程同理）。
        windowsHide: true,
      });
      this.child = child;
      this.ownedPid = child.pid;
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
   * Windows spawn 路径：经 WMI Win32_Process.Create 让 WmiPrvSE 拉起
   * cmd 包装——创建者在扩展宿主的 Job Object 之外，宿主被杀/窗口重载
   * 不再连带杀服务器（孤儿由 watchdog/lifecycle 自行收割，新宿主 attach
   * 接管）。stdout/stderr 重定向进 globalStorage/logs 由 spawnWatch 尾读：
   * 就绪正则、输出通道转发、超时与启动记录语义和 POSIX 路径对齐。
   *
   * cmd/ps1 两个脚本落盘而非 -Command 内联：嵌套引号不可控，文件可读可
   * 复跑，便于排查。ownedPid 记 cmd 壳 pid——taskkill /T 连带子孙 node。
   */
  private async spawnViaWmi(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    port: number,
    readyTimeoutMs: number,
  ): Promise<string | undefined> {
    const logsDir = path.join(this.context.globalStorageUri.fsPath, "logs");
    mkdirSync(logsDir, { recursive: true });
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    const logFile = path.join(logsDir, `server-${stamp}.log`);
    const cmdFile = path.join(logsDir, `spawn-${stamp}.cmd`);
    const ps1File = path.join(logsDir, `spawn-${stamp}.ps1`);

    // env：WMI 创建的进程继承 WmiPrvSE 环境（≠扩展宿主的）——不能走
    // 白名单：ELECTRON_RUN_AS_NODE（Electron 以 node 模式跑的开关，缺了
    // 会以真 Electron 起并退出）、PI_CODING_AGENT_DIR（e2e/多配置隔离）、
    // 代理/CA/NODE_OPTIONS、乃至未来的 PI_* 变量全是漏网鱼。对齐
    // cp.spawn 的 {...process.env} 语义：全量透传，只过滤破坏 .cmd 语法
    // 的项（引号/换行）与非法变量名。
    const seen = new Set<string>();
    const setLines = Object.entries(env)
      .filter(
        ([k, v]) =>
          v !== undefined &&
          /^[A-Za-z_][A-Za-z0-9_.]*$/.test(k) &&
          !/["\r\n]/.test(v) &&
          !seen.has(k.toUpperCase()) &&
          (seen.add(k.toUpperCase()), true),
      )
      .map(([k, v]) => `set "${k}=${v as string}"`);
    const quotedArgs = args.map((a) => `"${a.replace(/"/g, "")}"`).join(" ");
    writeFileSync(
      cmdFile,
      ["@echo off", ...setLines, `"${command}" ${quotedArgs} > "${logFile}" 2>&1`, ""].join("\r\n"),
    );
    // WMI 间接创建：cmd /s /c ""file"" 剥外层引号执行批处理。cwd 传宿主
    // 的——cp.spawn 默认继承 cwd，这里显式对齐同一语义。
    const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;
    writeFileSync(
      ps1File,
      [
        "$si = ([wmiclass]'Win32_ProcessStartup').CreateInstance()",
        "$si.ShowWindow = 0",
        `$r = ([wmiclass]'Win32_Process').Create(${psq(`cmd.exe /d /s /c ""${cmdFile}""`)}, ${psq(process.cwd())}, $si)`,
        'Write-Output "ret=$($r.ReturnValue);pid=$($r.ProcessId)"',
        "",
      ].join("\n"),
    );

    const pid = await new Promise<number | undefined>((resolve) => {
      cp.exec(
        `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${ps1File}"`,
        { timeout: 15_000, windowsHide: true },
        (e, out) => {
          const m = /ret=(\d+);pid=(\d+)/.exec(out);
          if (e || !m || m[1] !== "0") {
            this.channel.appendLine(
              `WMI spawn failed (ret=${m?.[1] ?? "?"}): ${e ? e.message : out.trim() || "no output"}`,
            );
            resolve(undefined);
            return;
          }
          resolve(Number(m[2]));
        },
      );
    });
    if (pid === undefined) return undefined;
    this.ownedPid = pid;
    // 启动窗口记录同 POSIX：兄弟窗口凭记录在端口未绑前 attach-等。
    const dropBootRecord = recordSpawnBoot(pid, port);
    logLifecycle(`spawn(wmi): pid=${pid}, port=${port}, log=${logFile}`);

    return new Promise<string | undefined>((resolve) => {
      let readyLogged = false;
      let settled = false;
      const settle = (v: string | undefined) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      const onLine = (line: string) => {
        this.channel.appendLine(line);
        const match = line.match(/https?:\/\/(127\.0\.0\.1|localhost):\d+/);
        if (match && !readyLogged) {
          readyLogged = true;
          dropBootRecord();
          const origin = match[0].replace("localhost", "127.0.0.1");
          logLifecycle(`spawn ready: origin=${origin}`);
          void fetch(origin).catch(() => undefined);
          settle(origin);
        }
      };
      // 进程死了（含意外崩溃）：标记并清全局，下次启动拉新进程——
      // 与 POSIX child.on('exit') 同语义，由 PID 存活巡检触发。
      const onExit = () => {
        dropBootRecord();
        this.clearSpawnWatch();
        this.channel.appendLine("Pi for IDE process exited (wmi-spawned tree is gone).");
        this.disposed = true;
        this.clearGlobalIfSelf();
        if (this.resolvedOrigin === undefined) settle(undefined);
      };
      let offset = 0;
      let buf = "";
      this.spawnWatchTimer = setInterval(() => {
        try {
          const size = statSync(logFile).size;
          if (size > offset) {
            const fd = openSync(logFile, "r");
            const chunk = Buffer.alloc(size - offset);
            readSync(fd, chunk, 0, chunk.length, offset);
            closeSync(fd);
            offset = size;
            buf += chunk.toString("utf8");
            let idx: number;
            while ((idx = buf.indexOf("\n")) >= 0) {
              onLine(buf.slice(0, idx).replace(/\r$/, ""));
              buf = buf.slice(idx + 1);
            }
          }
        } catch {
          // cmd 还没把文件写出来——下一轮再看。
        }
        try {
          process.kill(pid, 0);
        } catch {
          onExit();
        }
      }, 300);
      this.spawnWatchTimer.unref?.();
      setTimeout(() => {
        if (!readyLogged) {
          dropBootRecord();
          this.channel.appendLine(`Pi for IDE start timed out (${readyTimeoutMs / 1000}s).`);
          settle(undefined);
        }
      }, readyTimeoutMs).unref?.();
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
    emitServerStatus("Waiting for the server API…");
    this.channel.appendLine(
      "server is bound — waiting for /api/embed to answer (routes lazy-load on first hit)…",
    );
    let progressLogged = Date.now();
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
      // 静默等待是"卡死"观感的主要来源——每 ~10s 报一次还在等。
      if (Date.now() - progressLogged >= 10_000) {
        progressLogged = Date.now();
        this.channel.appendLine(
          `still waiting for /api/embed (${Math.round((Date.now() - (deadline - 90_000)) / 1000)}s elapsed, ${lastError})…`,
        );
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
