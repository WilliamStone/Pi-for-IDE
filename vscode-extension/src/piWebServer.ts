import * as cp from "child_process";
import { existsSync } from "fs";
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
 * 服务器监听 OS 分配的端口（`PORT=0`），我们从 stdout 抓取 Next 打印的
 * `http://127.0.0.1:<port>` 作为解析后的 origin。
 */
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
    this.channel = vscode.window.createOutputChannel("Pi Web");
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
      this.channel.appendLine("未找到 Pi Web 服务器。扩展包可能损坏。");
      void vscode.window.showErrorMessage("Pi Web 找不到内置服务器（resources/pi-web/server.js），扩展包可能损坏，请重新安装。");
      return Promise.resolve(undefined);
    }
    this.channel.appendLine(`Pi Web 服务器入口: ${serverPath}`);
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

  /** 用 PORT=0 启动 standalone 服务器并等待 Next 打印的 URL。 */
  private spawn(serverPath: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      // PORT=0 让 OS 分配空闲端口；Next 启动后会打印监听地址。
      const env: any = {
        ...process.env,
        PORT: "0",
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
        this.channel.appendLine(`Pi Web 进程退出，退出码 ${code}`);
        if (this.resolvedOrigin === undefined) resolve(undefined);
      });
      // 硬超时：30 秒还没打印 URL 就放弃。
      setTimeout(() => {
        if (this.resolvedOrigin === undefined) {
          this.channel.appendLine("Pi Web 启动超时。");
          resolve(undefined);
        }
      }, 30_000);
    });
  }
}
