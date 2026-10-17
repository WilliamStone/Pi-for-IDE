import * as cp from "child_process";
import { existsSync, readFileSync } from "fs";
import * as net from "net";
import * as path from "path";
import * as vscode from "vscode";

/**
 * 管理 pi-web 服务器的生命周期（独立进程）。
 *
 * pi-web 不打包进扩展，按以下顺序解析一个外部服务器入口：
 *   1. `piIde.executablePath` 配置（standalone 的 server.js 或包的 bin/pi-web.js）
 *   2. 扩展内置的 `resources/pi-web/server.js`（过渡期兼容；打包停止内置后自然消失）
 *   3. `npm root -g` 下已全局安装的 `piIde.package`（默认 @william_stone/pi-web-for-ide）
 *   4. `npx -y <piIde.package>` 兜底（首次联网下载，之后走缓存）
 *
 * 两种 spawn 模式：standalone server.js 只认 PORT/HOSTNAME 环境变量；
 * bin 脚本接受 --port/--hostname/--no-open 参数。两者都把监听地址打印到
 * stdout，统一用正则解析得到 origin。
 *
 * 服务器就绪后探测 `GET /api/embed`：返回 embed 协议标记说明是打过补丁的
 * pi-code web；404/异常说明接入了原版 pi-web（VSCode 集成功能不可用，提示
 * 用户更换安装源）。
 */

/** 默认起始端口：3030，被占用时自动 +1。 */
export const DEFAULT_PORT = 3030;

/**
 * 默认查询/安装的 npm 包名（含 embed 桥补丁的 pi-web 发行包）。
 * 可用 `piIde.package` 配置覆盖；置空则跳过全局安装与 npx 兜底。
 */
const DEFAULT_PACKAGE = "@william_stone/pi-web-for-ide";

/** 扩展支持的 embed 协议版本（与 pi-web /api/embed 返回值比对）。 */
const EMBED_PROTOCOL_SUPPORTED = 1;

/** npm registry 元数据地址（unscoped 包无需转义斜杠）。 */
const REGISTRY_LATEST_URL = (pkg: string) =>
  `https://registry.npmjs.org/${pkg.replace("/", "%2F")}/latest`;

type SpawnTarget =
  /** node <server.js>——standalone 产物，只认 PORT/HOSTNAME 环境变量。 */
  | { mode: "script"; path: string }
  /** node <bin/pi-web.js>——npm 包入口，接受 --port/--hostname/--no-open。 */
  | { mode: "bin"; path: string }
  /** npx -y <pkg>——兜底，首次运行联网下载。 */
  | { mode: "npx"; pkg: string };

/**
 * 探测从 startPort 开始的第一个空闲 TCP 端口（每次 +1，最多尝试 200 个）。
 */
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
              `PATH shim ${line} 指向 ${actualName ?? "未知包"}（期望 ${expectedPkg}），跳过。`,
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
    channel.appendLine("未找到 pnpm/npm，无法自动安装。");
    return false;
  }
  const spec = version ? `${pkg}@${version}` : pkg;
  const cmd = `${pm} i -g ${spec}`;
  channel.appendLine(`执行：${cmd}`);
  channel.show(true);
  return new Promise((resolve) => {
    const child = cp.spawn(cmd, { shell: true });
    child.stdout?.on("data", (d: Buffer) => channel.append(d.toString()));
    child.stderr?.on("data", (d: Buffer) => channel.append(d.toString()));
    child.on("error", (e) => {
      channel.appendLine(`安装进程启动失败：${e.message}`);
      resolve(false);
    });
    child.on("exit", (code) => {
      channel.appendLine(`安装进程退出，退出码 ${code}`);
      resolve(code === 0);
    });
  });
}

/**
 * 检查已全局安装的 pi-web 发行包是否有 npm 新版。
 * 只覆盖"全局安装"解析路径（executablePath/npx 无法定位本地副本就跳过）。
 * 返回 {current, latest}；未安装/检查失败返回 undefined。
 */
export async function checkPiWebUpdate(
  pkg: string,
): Promise<{ current: string; latest: string } | undefined> {
  const binPath = (await resolveGlobalPackageBin(pkg)) ?? (await resolvePathShimBin(pkg));
  if (!binPath) return undefined;
  const pkgJson = path.join(path.dirname(path.dirname(binPath)), "package.json");
  let current: string;
  try {
    current = JSON.parse(readFileSync(pkgJson, "utf8")).version;
  } catch {
    return undefined;
  }
  if (!current) return undefined;
  try {
    const res = await fetch(REGISTRY_LATEST_URL(pkg), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    const body = (await res.json().catch(() => null)) as { version?: unknown } | null;
    const latest = typeof body?.version === "string" ? body.version : "";
    return latest ? { current, latest } : undefined;
  } catch {
    return undefined;
  }
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
    if (existing && !existing.disposed) return Promise.resolve(existing);
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
    this.channel = vscode.window.createOutputChannel("pi for IDE");
    this.context.subscriptions.push(this.channel);
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
    if (this.child && this.child.exitCode === null) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // 尽力关闭。
      }
    }
  }

  // ------------------------------------------------------------------
  // 启动
  // ------------------------------------------------------------------
  /** 解析并启动 pi-web 服务器，返回解析后的 origin。 */
  private async startProcess(): Promise<string | undefined> {
    let target = await this.resolveServerTarget();
    if (!target) {
      // 所有解析路径失败（含 npx）→ 引导用户全局安装，成功后重试一次。
      const pkg = this.packageName();
      this.channel.appendLine("未找到可用的 pi-web 服务器。");
      const pick = await vscode.window.showErrorMessage(
        `pi for IDE 找不到 pi-web 服务器。可一键全局安装发行包 ${pkg}，或自行安装后重试。`,
        "一键安装",
        "稍后",
      );
      if (pick !== "一键安装") return undefined;
      const ok = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `正在安装 ${pkg}…` },
        () => installPiWebPackage(this.channel, pkg),
      );
      if (!ok) {
        void vscode.window.showErrorMessage(
          `${pkg} 安装失败，详情请见输出面板（查看 → 输出 → pi for IDE）。`,
        );
        return undefined;
      }
      target = await this.resolveServerTarget();
      if (!target) {
        void vscode.window.showErrorMessage(
          `${pkg} 已安装但仍解析不到入口，请查看输出面板日志。`,
        );
        return undefined;
      }
    }
    const origin = await this.spawn(target);
    if (origin) await this.verifyEmbedSupport(origin);
    return origin;
  }

  private packageName(): string {
    const config = vscode.workspace.getConfiguration("piIde");
    return (config.get<string>("package") ?? DEFAULT_PACKAGE).trim() || DEFAULT_PACKAGE;
  }

  /**
   * 按优先级解析服务器入口：
   *   executablePath → 内置 resources/pi-web/server.js → 全局 npm 包 → npx 兜底。
   */
  private async resolveServerTarget(): Promise<SpawnTarget | undefined> {
    const config = vscode.workspace.getConfiguration("piIde");

    // 1) 显式配置：接受 standalone server.js 或包内 bin/pi-web.js。
    const configured = config.get<string>("executablePath")?.trim();
    if (configured) {
      if (existsSync(configured)) {
        const target: SpawnTarget = path.basename(configured) === "server.js"
          ? { mode: "script", path: configured }
          : { mode: "bin", path: configured };
        this.channel.appendLine(`pi-web 入口（配置）: ${configured} [${target.mode}]`);
        return target;
      }
      this.channel.appendLine(`piIde.executablePath 不存在，忽略: ${configured}`);
    }

    // 2) 过渡期兼容：扩展内置的 standalone 产物（停止打包后该文件自然不存在）。
    const bundled = path.join(this.context.extensionPath, "resources", "pi-web", "server.js");
    if (existsSync(bundled)) {
      this.channel.appendLine(`pi-web 入口（内置）: ${bundled}`);
      return { mode: "script", path: bundled };
    }

    // 3) 全局 npm 安装的发行包。
    const pkg = this.packageName();
    const globalBin = await resolveGlobalPackageBin(pkg);
    if (globalBin) {
      this.channel.appendLine(`pi-web 入口（全局安装）: ${globalBin}`);
      return { mode: "bin", path: globalBin };
    }

    // 4) PATH 上的 pi-web shim（pnpm/yarn/bun 全局安装都会落这里；
    //    shim 脚本内含真实 bin/pi-web.js 路径，解析后仍走 node 直启，
    //    避免经 .cmd 外壳导致 stop 杀不死内层服务进程）。
    const shimBin = await resolvePathShimBin(pkg, (l) => this.channel.appendLine(l));
    if (shimBin) {
      this.channel.appendLine(`pi-web 入口（PATH shim）: ${shimBin}`);
      return { mode: "bin", path: shimBin };
    }

    // 5) npx 兜底：首次运行会联网下载，之后走 npx 缓存。
    this.channel.appendLine(`pi-web 入口（npx）: ${pkg}`);
    return { mode: "npx", pkg };
  }

  /** 探测空闲端口后按目标模式启动服务器，等待 stdout 打印的 URL。 */
  private async spawn(target: SpawnTarget): Promise<string | undefined> {
    // 读取用户配置的起始端口（默认 3030），探测第一个空闲端口。
    const config = vscode.workspace.getConfiguration("piIde");
    const preferred =
      typeof config.get<number>("port") === "number"
        ? config.get<number>("port", DEFAULT_PORT)
        : DEFAULT_PORT;
    const port = await findFreePort(Math.max(1, preferred || DEFAULT_PORT));
    this.channel.appendLine(
      `pi for IDE 端口探测：起始 ${preferred}，使用 ${port}${port === 0 ? "（OS 分配）" : ""}`,
    );

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
    let useShell = false;
    switch (target.mode) {
      case "script":
        command = process.execPath;
        args = [target.path];
        break;
      case "bin":
        command = process.execPath;
        args = [target.path, ...launchArgs];
        break;
      case "npx":
        command = "npx";
        // -p 显式指定包：包名与 bin 名不同（pi-web）时 npx 无法推断。
        // -p 显式指定包；bin 名 pi-web-for-ide（与上游 pi-web 不撞名）。
        args = ["-y", "-p", target.pkg, "pi-web-for-ide", ...launchArgs];
        // Windows 上 npx 是 .cmd shim，必须经 shell 启动。
        useShell = process.platform === "win32";
        this.channel.appendLine(`首次经 npx 启动需联网下载 ${target.pkg}，可能较慢。`);
        break;
    }

    // npx 首次下载可能远超 30s，给更长超时。
    const readyTimeoutMs = target.mode === "npx" ? 180_000 : 30_000;

    return new Promise((resolve) => {
      const child = cp.spawn(command, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: useShell,
      });
      this.child = child;
      const onLine = (line: string) => {
        this.channel.appendLine(line);
        // Next 启动会打印类似 `- Local: http://localhost:39211`，也可能
        // 打印 127.0.0.1。两种都识别。
        const match = line.match(/https?:\/\/(127\.0\.0\.1|localhost):\d+/);
        if (match) {
          // 归一化成 127.0.0.1，避免 localhost 在严格 CSP 下出问题。
          const origin = match[0].replace("localhost", "127.0.0.1");
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
        this.channel.appendLine(`pi for IDE 进程启动失败：${err.message}`);
        if (this.resolvedOrigin === undefined) resolve(undefined);
      });
      child.on("exit", (code) => {
        this.channel.appendLine(`pi for IDE 进程退出，退出码 ${code}`);
        // 进程死了（含意外崩溃）：标记并清全局，下次启动拉新进程。
        this.disposed = true;
        this.clearGlobalIfSelf();
        if (this.resolvedOrigin === undefined) resolve(undefined);
      });
      setTimeout(() => {
        if (this.resolvedOrigin === undefined) {
          this.channel.appendLine(`pi for IDE 启动超时（${readyTimeoutMs / 1000}s）。`);
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
            `embed 协议握手成功：protocol v${data.embed.protocol}，服务器版本 ${data.embed.version ?? "未知"}`,
          );
          this.checkProtocolCompat(data.embed.protocol, data.embed.version);
          return;
        }
        if (res.status === 404) {
          lastError = "HTTP 404（路由不存在）";
          break; // 服务器在跑但确实没有 embed 路由——原版，立即警告
        }
        lastError = `HTTP ${res.status}`;
      } catch (e) {
        lastError = String(e);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!gotHttpResponse) {
      this.channel.appendLine(`警告：/api/embed 探测 90s 内未获 HTTP 响应（${lastError}）——服务器可能仍在启动或已崩溃。`);
      void vscode.window.showWarningMessage(
        "pi for IDE：服务器启动后 90 秒仍未响应，请查看输出面板（pi for IDE）中的 spawn 日志，或执行「pi for IDE: 停止服务器」后重试。",
      );
      return;
    }
    // 5xx ≠ 原版：服务器在跑但路由抛错，多半是发行包安装不完整
    // （典型：pnpm/npm 拦了 postinstall，junction 未建）——提示重装/升级，
    // 而不是误报成"原版 pi-web"。
    if (saw5xx) {
      this.channel.appendLine(`警告：/api/embed 返回 ${lastError}——服务器在运行但路由报错，发行包可能安装不完整。`);
      void vscode.window.showWarningMessage(
        `pi for IDE：pi-web 服务器启动但接口报错（${lastError}），安装可能不完整。请重装发行包：pnpm remove -g pi-web-for-ide && pnpm add -g ${this.packageName()}@latest，或查看输出面板（pi for IDE）。`,
      );
      return;
    }
    this.channel.appendLine(`警告：/api/embed 探测失败（${lastError}）——所连 pi-web 可能未包含 embed 桥补丁。`);
    void vscode.window.showWarningMessage(
      `pi for IDE：所连接的 pi-web 缺少 IDE 集成功能（疑似原版 pi-web）。请安装含补丁的发行包：npm i -g ${this.packageName()}。`,
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
        `pi-web${ver} 的 embed 协议（v${protocol}）高于扩展支持的 v${EMBED_PROTOCOL_SUPPORTED}，IDE 集成功能可能异常。请在扩展商店升级 pi for IDE 扩展。`,
      );
    } else {
      void vscode.window.showWarningMessage(
        `pi-web${ver} 的 embed 协议（v${protocol}）低于扩展支持的 v${EMBED_PROTOCOL_SUPPORTED}，IDE 集成功能可能异常。请升级发行包：npm i -g ${pkg}@latest。`,
      );
    }
    this.channel.appendLine(
      `embed 协议不匹配：服务器 v${protocol}（${ver || "版本未知"}）vs 扩展支持 v${EMBED_PROTOCOL_SUPPORTED}`,
    );
  }
}
