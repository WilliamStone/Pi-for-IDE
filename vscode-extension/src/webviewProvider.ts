import * as vscode from "vscode";
import type { PiIdeServer } from "./piIdeServer";
import { currentServerStatus, logLifecycle, onServerStatus } from "./server-status";
import type { Bridge } from "./bridge";
import { buildEmbedUrl } from "./embedUrl";
import { piConfig } from "./config";

/**
 * Webview panel that hosts the pi-web UI inside a VSCode editor column.
 *
 * Unlike a WebviewView (which lives in the sidebar/panel bar), a WebviewPanel
 * opens as a normal editor tab — so it can be placed on the right side
 * (`ViewColumn.Beside`), split, moved, and remembered by the layout like any
 * other document. This matches the user's request to show pi-web "on the
 * right side" instead of pinned to the bottom panel.
 *
 * The panel HTML is a thin wrapper: a full-page <iframe> pointing at the
 * running pi-web server (with ?embed=vscode so the page enables host mode)
 * plus a tiny bridge script that relays messages between the iframe and the
 * VSCode extension host.
 *
 * Message path:
 *   pi-web page (iframe)
 *     -- window.parent.postMessage({ source: "embed", id, request }) --> webview document
 *     -- vscode.postMessage({ source: "embed", id, request }) --> extension host
 *     <-- webview.postMessage({ source: "host", id, payload }) -- extension host
 *     <-- iframe.contentWindow.postMessage({ source: "host", id, payload }) -- webview document
 *     <-- window 'message' listener -- pi-web page (lib/embed/bridge.ts)
 */
export class PiWebWebviewPanel extends vscode.Disposable {
  private static nextSeq = 1;
  private readonly seq = PiWebWebviewPanel.nextSeq++;

  /** 日志身份标签：多面板并存时 refresh/webview 行分不清是谁——
   *  会话面板按 sessionId 缩写，其余按 view 名 + 实例序号。 */
  private label(): string {
    if (this.sessionId) return `s:${this.sessionId.slice(0, 8)}`;
    return `${this.panelView ?? "main"}#${this.seq}`;
  }

  private panel: vscode.WebviewPanel | undefined;
  private currentCwd: string | undefined;
  /** 宿主钉住的会话——原生侧栏点选后 URL 带 ?session= 深链。 */
  private sessionId: string | undefined;
  /** 会话面板用会话名作 tab 标题；未设时回退 "Pi for IDE — <cwd>"。 */
  private titleOverride: string | undefined;

  /** 更新面板标题（会话面板 = 会话名）。 */
  setTitleOverride(title: string): void {
    this.titleOverride = title;
    if (this.panel) this.panel.title = title;
  }

  /** 面板当前所在列——会话 tab 组锚定用（未打开时 undefined）。 */
  get currentViewColumn(): vscode.ViewColumn | undefined {
    return this.panel?.viewColumn;
  }
  /** 面板当前 cwd（composer 落地后仍是该会话的工作目录）。 */
  get cwd(): string | undefined {
    return this.currentCwd;
  }
  /** 面板绑定的会话 id（composer 未落地时为 undefined）。 */
  get session(): string | undefined {
    return this.sessionId;
  }
  /** tab 是否当前激活——editor/title/context 命令反查面板归属用。 */
  get isActive(): boolean {
    return this.panel?.active ?? false;
  }
  /** tab 标题——editor/title/context 入参的 tab.label 反查面板归属用。 */
  get title(): string | undefined {
    return this.panel?.title;
  }
  /** 上次渲染 iframe 用的服务器实例与 URL——变了才重载 iframe。 */
  private lastServer: PiIdeServer | undefined;
  private lastUrl: string | undefined;
  /** 最近一次发到 shell 的失败文案（重放用——shell 上线晚于事件时会丢推送）。 */
  private lastShellError: string | undefined;
  /** shell 脚本已执行（"shell painted" 回执）——冷启动慢时给加载浮窗。 */
  private shellReady = false;
  private shellReadyWaiters: Array<() => void> = [];

  private markShellReady(): void {
    this.shellReady = true;
    for (const r of this.shellReadyWaiters.splice(0)) r();
    this.replayShellState();
  }

  /**
   * shell.js 外置后脚本执行可能远晚于事件推送（webview.postMessage 在
   * 页面脚本注册监听前到达会被丢弃）——shell 报到时把最新状态重放：
   * error 最优先，其次就绪 URL，再次阶段文案。
   */
  private replayShellState(): void {
    if (!this.panel) return;
    if (this.lastShellError) {
      this.panel.webview.postMessage({
        source: "host",
        payload: { kind: "serverError", text: this.lastShellError },
      });
    } else if (this.lastUrl && this.lastServer) {
      this.panel.webview.postMessage({
        source: "host",
        payload: { kind: "serverReady", url: this.lastUrl, probe: this.lastServer.origin },
      });
    } else {
      this.panel.webview.postMessage({
        source: "host",
        payload: { kind: "status", text: currentServerStatus() },
      });
    }
  }

  /** resolve 于 shell 上屏或面板销毁——给 withProgress 用（自动关浮窗）。 */
  private shellReadyPromise(): Promise<void> {
    if (this.shellReady || !this.panel) return Promise.resolve();
    return new Promise((r) => this.shellReadyWaiters.push(r));
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getServer: () => Promise<PiIdeServer | undefined>,
    private readonly ensureServer: () => Promise<PiIdeServer | undefined>,
    private readonly bridge: Bridge,
    private readonly extensionVersion: string,
    /** 面板销毁回调——会话面板注册表据此清掉映射（tab 对应 session）。 */
    private readonly onDisposed?: () => void,
    /** 精简页面形态（"chat"|"settings"）——URL 恒带 view=<值>。 */
    private readonly panelView?: string,
    /** 页面落地到具体会话时的回报（new:<cwd> composer → 真会话）——
     * 宿主侧据此把面板重挂到 sessionId 键下。 */
    private readonly onSessionBound?: (sessionId: string, title?: string) => void,
  ) {
    super(() => this.dispose());
    // 服务器阶段状态（下载/启动）实时推到面板——等待页/门页据此换文案。
    onServerStatus((text) => {
      this.panel?.webview.postMessage({
        source: "host",
        payload: { kind: "status", text },
      });
    });
  }

  /**
   * 服务器实例变化后刷新已打开的 iframe（升级/重启）——不聚焦、
   * 面板没开就是空操作。
   */
  async refreshIfOpen(): Promise<void> {
    if (!this.panel) return;
    await this.refresh();
  }

  /**
   * Reveal the panel in the given column, (re)loading it with `cwd` if the
   * cwd changed or the panel was disposed.
   */
  async reveal(cwd: string, viewColumn: vscode.ViewColumn, sessionId?: string): Promise<void> {
    logLifecycle(`reveal[${this.label()}]: cwd=${cwd || "(none)"} session=${sessionId ?? "(latest)"}`);
    const cwdChanged = this.currentCwd !== cwd || this.sessionId !== sessionId;
    this.currentCwd = cwd;
    this.sessionId = sessionId;

    if (this.panel && !cwdChanged) {
      // Same cwd — 聚焦面板（不传列：reveal("Beside") 会把已定位的面板重新
      // 相对活动编辑器排布，多会话面板互点时会成对搬家、原组塌缩）。
      this.panel.reveal(undefined, false);
      await this.refresh();
      return;
    }

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "piIde.webview",
        "Pi for IDE",
        viewColumn,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        },
      );
      // iconPath is settable after creation (the constructor type doesn't
      // declare it, but WebviewPanel does).
      this.panel.iconPath = vscode.Uri.joinPath(
        this.extensionUri,
        "resources",
        "icons",
        "icon-128.png",
      );

      logLifecycle(`panel created[${this.label()}] (createWebviewPanel)`);
      // 单文档外壳只赋一次——后续状态切换全走 postMessage，不再整页 reload。
      this.shellReady = false;
      this.panel.webview.html = this.renderShell(currentServerStatus());
      logLifecycle(`shell rendered[${this.label()}] (renderShell)`);
      // webview 冷启动被渲染进程争抢/杀软拖到分钟级时，面板全程空白像
      // 卡死——6s 还没上屏就挂个进度浮窗说明在加载（shell 报到后自动关）。
      const panel = this.panel;
      setTimeout(() => {
        if (this.shellReady || this.panel !== panel) return;
        void vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Pi for IDE panel is loading (webview init is slow)…",
            cancellable: false,
          },
          () => this.shellReadyPromise(),
        );
      }, 6000);
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.currentCwd = undefined;
        // 缓存随面板销毁失效——新面板必须重新渲染 HTML，否则
        // 同实例同 URL 的提前返回会让新 webview 永久空白。
        this.lastServer = undefined;
        this.lastUrl = undefined;
        // 面板没了，等"上屏"的浮窗也收掉。
        for (const r of this.shellReadyWaiters.splice(0)) r();
        this.onDisposed?.();
      });

      // Bridge messages from the pi-web iframe to VSCode APIs and relay
      // responses back. Messages arrive as { source: "embed", id, request }.
      this.panel.webview.onDidReceiveMessage(async (message) => {
        if (!message) return;
        if (message.source === "piIde.log") {
          logLifecycle(`webview[${this.label()}]: ${String(message.text ?? "")}`);
          if (message.text === "shell painted") this.markShellReady();
          return;
        }
        if (message.source !== "embed") return;
        // 会话落地通知（notifyEmbedHost 单向投递，无 id、不走
        // request/response 往返）——先于 bridge.handle 拦截。
        if (message.request?.kind === "sessionSelected" && typeof message.request.sessionId === "string") {
          this.bindSession(message.request.sessionId);
          this.onSessionBound?.(message.request.sessionId, message.request.title);
          return;
        }
        try {
          const payload = await this.bridge.handle(message.request);
          this.panel?.webview.postMessage({
            source: "host",
            id: message.id,
            payload,
          });
        } catch (error) {
          this.panel?.webview.postMessage({
            source: "host",
            id: message.id,
            payload: { error: String(error) },
          });
        }
      });
    } else {
      this.panel.reveal(undefined, false);
    }

    await this.refresh();
  }

  /**
   * 把面板钉到会话 id 上（composer 面板创建会话后由 sessionSelected 触发）——
   * 之后 refresh 重建的 URL 带 ?session=，刷新/重启都能回到该会话。
   */
  bindSession(sessionId: string): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.lastUrl = undefined;
  }

  /** 只聚焦现有面板（不重载）。未创建时为空操作。 */
  focus(): void {
    if (this.panel) {
      this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active, true);
    }
  }

  /** 面板是否已经创建。用于决定是否需要先 reveal 再推消息。 */
  isReady(): boolean {
    return !!this.panel;
  }

  /** settings 视图的目标小节（piIde.settings 命令参数）。下次刷新随 URL 生效。 */
  panelSection?: string;

  /**
   * 向 pi-web 页面推送一条无 id 的「提及」通知（扩展宿主动发起）。
   * 用于右键菜单「提及此文件 / 提及此代码」。面板未创建时自动 reveal。
   */
  async pushMention(payload: {
    relativePath: string;
    startLine?: number;
    endLine?: number;
    selectedText?: string;
  }): Promise<void> {
    // 若面板还没创建，先 reveal 一个（带 cwd）。这里 cwd 传空字符串走默认流程。
    if (!this.panel) {
      return; // reveal 由 piIde.open 命令负责，这里仅推送。
    }
    this.panel.webview.postMessage({
      source: "host",
      payload: { kind: "mention", ...payload },
    });
  }

  /**
   * 向 pi-web 页面推送「当前活动编辑器」通知（扩展宿主动发起）。
   * 用于让 AI 知道用户正在看哪个文件：前端把当前文件注入 system prompt 的隐藏
   * 上下文，并在输入框下方展示提示。
   */
  pushActiveEditor(payload: {
    /** 相对工作区根目录的路径（不含前导 ./），如 "src/app.tsx"。 */
    relativePath: string | null;
    /** 绝对路径。 */
    filePath: string | null;
  }): void {
    if (!this.panel) return;
    this.panel.webview.postMessage({
      source: "host",
      payload: { kind: "activeEditorChanged", ...payload },
    });
  }

  override dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  // ------------------------------------------------------------------
  // HTML rendering
  // ------------------------------------------------------------------

  private async refresh(): Promise<void> {
    if (!this.panel) return;

    logLifecycle(`refresh[${this.label()}]: awaiting server promise…`);
    let server = await this.getServer();
    if (!server) {
      // Try to start it now (covers the case where the user opened the panel
      // before piIde.start finished).
      logLifecycle(`refresh[${this.label()}]: no instance, triggering ensureServer`);
      server = await this.ensureServer();
    }
    logLifecycle(`refresh[${this.label()}]: server ready origin=${server?.resolvedOrigin ?? "undefined"}`);

    const title = this.titleOverride ?? (this.currentCwd ? `Pi for IDE — ${shortPath(this.currentCwd)}` : "Pi for IDE");
    this.panel.title = title;

    if (!server) {
      this.lastServer = undefined;
      this.lastUrl = undefined;
      this.lastShellError =
        "Pi for IDE server failed to start. See the output panel (View → Output → Pi for IDE).";
      this.panel.webview.postMessage({
        source: "host",
        payload: { kind: "serverError", text: this.lastShellError },
      });
      return;
    }

    // 参数契约集中在 embedUrl.ts（session/cwd 互斥、view 族参数的消费
    // 边界都在那里注释+测试）——本处只喂当前面板状态。
    const urlStr = buildEmbedUrl(server.origin, {
      inst: server.embedBoot ?? "",
      extVer: this.extensionVersion,
      sessionId: this.sessionId,
      cwd: this.currentCwd,
      view: this.panelView,
      section: this.panelSection,
      browserBtn:
        this.panelView === "chat"
          ? piConfig().get<boolean>("showOpenInBrowser", true)
          : undefined,
    });

    // 同实例同 URL 也重推——判重由 shell 做（loadedUrl+display+offline 态），
    // 宿主若提前返回，iframe 停在 SW offline 兜底页时再次点同一会话会永远
    // 收不到 serverReady，自愈链没有重新武装的机会。
    this.lastServer = server;
    this.lastUrl = urlStr;
    this.lastShellError = undefined;
    this.panel.webview.postMessage({
      source: "host",
      payload: { kind: "serverReady", url: urlStr, probe: server.origin },
    });
    logLifecycle(`serverReady posted[${this.label()}] url=${urlStr}`);
  }

  /**
   * 单文档外壳：等待页/阶段状态/连接门/错误页/iframe 全在一个 HTML 里——
   * webview 每次 `webview.html=` 重赋值都是整页 reload（数秒级），状态切换
   * 改用 postMessage 驱动，整个生命周期只加载一次。
   */
  private renderShell(initialStatus: string): string {
    // 外壳脚本走静态资源——CSP 只允许 vscode-resource: 源（禁内联脚本）。
    const shellSrc = this.panel!.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "resources", "shell.js"),
    );
    const csp =
      `default-src 'none'; style-src 'unsafe-inline'; ` +
      `script-src ${this.panel!.webview.cspSource}; ` +
      `connect-src http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; ` +
      `frame-src http://127.0.0.1:* http://localhost:*`;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Pi for IDE</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: #1a1a1a; }
    iframe { width: 100%; height: 100%; border: 0; display: block; }
    #gate {
      position: fixed; inset: 0; display: grid; place-items: center;
      color: #e8e8e8; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #1a1a1a; z-index: 10;
    }
    #gate main { width: min(100%, 420px); text-align: center; padding: 32px; }
    #gate h1 { margin: 0 0 10px; font-size: 20px; font-weight: 650; }
    #gate p { margin: 0; color: #9ca3af; font-size: 14px; line-height: 1.6; }
    #gate.error h1 { color: #f87171; }
    #gate .dots span { animation: blink 1.2s infinite; }
    #gate .dots span:nth-child(2) { animation-delay: .2s; }
    #gate .dots span:nth-child(3) { animation-delay: .4s; }
    @keyframes blink { 50% { opacity: .25; } }
  </style>
</head>
<body>
  <!-- 就绪门：服务器可达前不指 iframe——避免 pi-web service worker 的
       offline.html 兜底页在冷启动时闪现（它不是错误页，是误导）。 -->
  <div id="gate"><main>
    <h1>Pi for IDE</h1>
    <p id="gate-text">${initialStatus}<span class="dots"><span>.</span><span>.</span><span>.</span></span></p>
  </main></div>
  <iframe id="pi-web-frame" title="Pi for IDE" style="display:none"></iframe>
  <script src="${shellSrc}"></script>
</body>
</html>`;
  }
}

function shortPath(p: string): string {
  // Shorten /Users/xdf/mine-code/pi-code -> ~/mine-code/pi-code for the tab title.
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}
