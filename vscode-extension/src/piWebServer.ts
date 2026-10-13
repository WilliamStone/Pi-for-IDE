import * as cp from "child_process";
import { existsSync } from "fs";
import * as net from "net";
import * as path from "path";
import * as vscode from "vscode";

/**
 * 管理 pi-web Next.js 服务器的生命周期（独立进程）。
 *
 * 为了让用户「安装扩展即用、无需全局安装 pi-web」，我们把 pi-web 的
 * `next build` 产出的 standalone 服务器（`.next/standalone`）连同精简后的
 * `node_modules` 和 `.next/static` 一起打包进扩展的
 * `resources/pi-web/`。启动时直接 `node resources/pi-web/server.js`，
 * 不再依赖 PATH 上的 `pi-web`。
 *
 * 服务器默认监听 `piWeb.port` 指定的端口（默认 3030）。启动前先从该端口
 * 开始探测一个空闲端口（被占用则 +1 继续），再以固定端口启动，方便用户在
 * 浏览器中直接访问。我们从 stdout 抓取 Next 打印的
 * `http://127.0.0.1:<port>` 作为解析后的 origin（兜底确认实际端口）。
 */

/** 默认起始端口：3030，被占用时自动 +1。 */
export const DEFAULT_PORT = 3030;

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
export class PiWebServer {
  context: vscode.ExtensionContext;
  child?: cp.ChildProcess;
  ready: Promise<string | undefined>;
  resolvedOrigin?: string;
  channel: vscode.OutputChannel;
  disposed = false;

  static ensureStarted(context: vscode.ExtensionContext): Promise<PiWebServer | undefined> {
    const existing = (globalThis as Record<string, unknown>).__piWebServer as PiWebServer | undefined;
    if (existing) return Promise.resolve(existing);
    const server = new PiWebServer(context);
    (globalThis as Record<string, unknown>).__piWebServer = server;
    return server.start();
  }

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.channel = vscode.window.createOutputChannel("PI Code");
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
  /** 定位并启动 pi-web standalone 服务器，返回解析后的 origin。 */
  private startProcess(): Promise<string | undefined> {
    const serverPath = this.resolveServerPath();
    if (!serverPath) {
      this.channel.appendLine("未找到 PI Code 服务器。扩展包可能损坏。");
      void vscode.window.showErrorMessage("PI Code 找不到内置服务器（resources/pi-web/server.js），扩展包可能损坏，请重新安装。");
      return Promise.resolve(undefined);
    }
    this.channel.appendLine(`PI Code 服务器入口: ${serverPath}`);
    return this.spawn(serverPath);
  }

  /**
   * 解析 standalone 服务器入口路径。优先扩展内置的 `resources/pi-web/server.js`。
   */
  private resolveServerPath(): string | undefined {
    const bundled = path.join(this.context.extensionPath, "resources", "pi-web", "server.js");
    if (existsSync(bundled)) return bundled;
    return undefined;
  }

  /** 探测空闲端口后启动 standalone 服务器，并等待 Next 打印的 URL。 */
  private async spawn(serverPath: string): Promise<string | undefined> {
    // 读取用户配置的起始端口（默认 3030），探测第一个空闲端口。
    const config = vscode.workspace.getConfiguration("piWeb");
    const preferred =
      typeof config.get<number>("port") === "number"
        ? config.get<number>("port", DEFAULT_PORT)
        : DEFAULT_PORT;
    const port = await findFreePort(Math.max(1, preferred || DEFAULT_PORT));
    this.channel.appendLine(
      `PI Code 端口探测：起始 ${preferred}，使用 ${port}${port === 0 ? "（OS 分配）" : ""}`,
    );

    return new Promise((resolve) => {
      // 固定端口启动；若启动瞬间被抢占，Next 会打印实际地址或直接退出，
      // 由下方的 stdout 解析 / exit 处理兜底。
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        NODE_ENV: "production",
      };
      const child = cp.spawn(process.execPath, [serverPath], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
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
      child.on("exit", (code) => {
        this.channel.appendLine(`PI Code 进程退出，退出码 ${code}`);
        if (this.resolvedOrigin === undefined) resolve(undefined);
      });
      // 硬超时：30 秒还没打印 URL 就放弃。
      setTimeout(() => {
        if (this.resolvedOrigin === undefined) {
          this.channel.appendLine("PI Code 启动超时。");
          resolve(undefined);
        }
      }, 30_000);
    });
  }
}
