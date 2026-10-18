import * as cp from "child_process";
import * as vscode from "vscode";
import { EMBED_PROTOCOL_SUPPORTED } from "./managedRuntime";
import { DEFAULT_PACKAGE } from "./occupier";
import { reportStartupFailure } from "./diagnostics";
import { findFreePort, reportPortOccupiers, scanPortOccupiers } from "./port-scan";
import {
  installPiWebPackage,
  resolveServerTarget,
  SpawnTarget,
} from "./server-resolve";
import { logLifecycle, outputChannel } from "./server-status";

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
  heartbeatTimer?: ReturnType<typeof setInterval>;

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
    this.stopHeartbeat();
    const child = this.child;
    if (!child || child.exitCode !== null || child.pid === undefined) {
      // 接入来的服务器不持有进程句柄；声明 lifecycle.shutdown 时让服务端
      // 自行优雅退出（共享服务器的正确关法），老服务器则无法停。
      if (this.resolvedOrigin && this.embedCapabilities["lifecycle.shutdown"]) {
        try {
          await fetch(`${this.resolvedOrigin}/api/embed/shutdown`, {
            method: "POST",
            signal: AbortSignal.timeout(5_000),
          });
          this.channel.appendLine("asked the shared server to shut down (lifecycle.shutdown).");
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
  private async startProcess(): Promise<string | undefined> {
    // 先扫 ours 端口再进解析：另一窗口/扩展宿主重启留下的孤儿在跑时直接
    // 接入，省掉整条解析链（尤其 managed 腿缺失时那一次 ~540MB 的安装）。
    const attached = await this.attachToRunningServer(3_000);
    if (attached) {
      await this.verifyEmbedSupport(attached);
      this.startHeartbeat();
      return attached;
    }
    let target = await resolveServerTarget(this.context, this.channel, this.packageName());
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
      target = await resolveServerTarget(this.context, this.channel, this.packageName());
      if (!target) {
        void vscode.window.showErrorMessage(
          `${pkg} installed but the entry still cannot be resolved; check the output log.`,
        );
        return undefined;
      }
    }
    // spawn 失败也可能就是撞口竞态：对方在 probe→spawn 间隙绑定。给 30s
    // 窗口再扫一次，仍接入而非报错。
    const origin = (await this.spawn(target)) ?? (await this.attachToRunningServer(30_000));
    if (origin) {
      await this.verifyEmbedSupport(origin);
      this.startHeartbeat();
    }
    if (!origin) await reportStartupFailure(this.channel, this.context, this.packageName(), target);
    return origin;
  }

  private packageName(): string {
    const config = vscode.workspace.getConfiguration("Pi for IDE");
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
    const deadline = Date.now() + graceMs;
    let waitLogged = false;
    do {
      const ours = (await scanPortOccupiers(undefined, undefined, this.packageName())).filter((o) => o.kind === "ours");
      if (!ours.length && !waitLogged) return undefined;
      for (const o of ours) {
        const origin = `http://127.0.0.1:${o.port}`;
        try {
          const res = await fetch(`${origin}/api/embed`, { signal: AbortSignal.timeout(4_000) });
          if (!res.ok) continue;
          this.channel.appendLine(
            `attached to running Pi Web server on :${o.port} (PID ${o.pid}) — skipping duplicate spawn.`,
          );
          logLifecycle(`attached ours: origin=${origin}, pid=${o.pid}`);
          return origin;
        } catch {
          // 还在启动：下一轮再试。
        }
      }
      if (ours.length && !waitLogged) {
        waitLogged = true;
        this.channel.appendLine(
          `our pi-web on :${ours.map((o) => o.port).join("/")} is still starting — waiting to attach…`,
        );
      }
      if (Date.now() < deadline) await new Promise((r) => setTimeout(r, 2_000));
    } while (Date.now() < deadline);
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
          | { embed?: { protocol?: number; version?: string; capabilities?: Record<string, unknown> } }
          | null;
        if (res.ok && data?.embed?.protocol) {
          this.embedCapabilities = data.embed.capabilities ?? {};
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
