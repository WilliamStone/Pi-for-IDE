import * as vscode from "vscode";
import type { PiIdeServer } from "./piIdeServer";
import { currentServerStatus, logLifecycle, onServerStatus } from "./piIdeServer";
import type { Bridge } from "./bridge";

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
  private panel: vscode.WebviewPanel | undefined;
  private currentCwd: string | undefined;
  /** 上次渲染 iframe 用的服务器实例与 URL——变了才重载 iframe。 */
  private lastServer: PiIdeServer | undefined;
  private lastUrl: string | undefined;
  /** shell 脚本已执行（"shell painted" 回执）——冷启动慢时给加载浮窗。 */
  private shellReady = false;
  private shellReadyWaiters: Array<() => void> = [];

  private markShellReady(): void {
    this.shellReady = true;
    for (const r of this.shellReadyWaiters.splice(0)) r();
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
   * Reveal the panel in the given column, (re)loading it with `cwd` if the
   * cwd changed or the panel was disposed.
   */
  async reveal(cwd: string, viewColumn: vscode.ViewColumn): Promise<void> {
    logLifecycle(`reveal: cwd=${cwd || "(none)"}`);
    const cwdChanged = this.currentCwd !== cwd;
    this.currentCwd = cwd;

    if (this.panel && !cwdChanged) {
      // Same cwd — 聚焦面板；refresh 内部判断服务器实例是否变了，
      // stop/start 后会把 iframe 重指到新地址，未变时不动（保住会话状态）。
      this.panel.reveal(viewColumn, false);
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

      logLifecycle("panel created (createWebviewPanel)");
      // 单文档外壳只赋一次——后续状态切换全走 postMessage，不再整页 reload。
      this.shellReady = false;
      this.panel.webview.html = this.renderShell(currentServerStatus());
      logLifecycle("shell rendered (renderShell)");
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
      });

      // Bridge messages from the pi-web iframe to VSCode APIs and relay
      // responses back. Messages arrive as { source: "embed", id, request }.
      this.panel.webview.onDidReceiveMessage(async (message) => {
        if (!message) return;
        if (message.source === "piIde.log") {
          logLifecycle(`webview: ${String(message.text ?? "")}`);
          if (message.text === "shell painted") this.markShellReady();
          return;
        }
        if (message.source !== "embed") return;
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
      this.panel.reveal(viewColumn, false);
    }

    await this.refresh();
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

  /**
   * 向 pi-web 页面推送一条无 id 的「提及」通知（扩展宿主动发起）。
   * 用于右键菜单「提及此文件 / 提及此代码」。面板未创建时自动 reveal。
   */
  async pushMention(payload: {
    relativePath: string;
    startLine?: number;
    endLine?: number;
    selectedText?: string;
  }, viewColumn?: vscode.ViewColumn): Promise<void> {
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

    logLifecycle("refresh: awaiting server promise…");
    let server = await this.getServer();
    if (!server) {
      // Try to start it now (covers the case where the user opened the panel
      // before piIde.start finished).
      logLifecycle("refresh: no instance, triggering ensureServer");
      server = await this.ensureServer();
    }
    logLifecycle(`refresh: server ready origin=${server?.resolvedOrigin ?? "undefined"}`);

    const title = this.currentCwd ? `Pi for IDE — ${shortPath(this.currentCwd)}` : "Pi for IDE";
    this.panel.title = title;

    if (!server) {
      this.lastServer = undefined;
      this.lastUrl = undefined;
      this.panel.webview.postMessage({
        source: "host",
        payload: {
          kind: "serverError",
          text: "Pi for IDE server failed to start. See the output panel (View → Output → Pi for IDE).",
        },
      });
      return;
    }

    const url = new URL(server.origin);
    url.searchParams.set("embed", "vscode");
    if (this.currentCwd) url.searchParams.set("cwd", this.currentCwd);
    url.searchParams.set("extVer", this.extensionVersion);
    const urlStr = url.toString();

    // 服务器实例与 URL 都没变就不重推——避免每次点状态栏都重载 iframe
    // 丢失页面状态；stop 后再 start 实例必变，shell 收到新 url 会重新探测。
    if (server === this.lastServer && urlStr === this.lastUrl) return;
    this.lastServer = server;
    this.lastUrl = urlStr;
    this.panel.webview.postMessage({
      source: "host",
      payload: { kind: "serverReady", url: urlStr, probe: server.origin },
    });
    logLifecycle("serverReady posted (shell-side probe)");
  }

  /**
   * 单文档外壳：等待页/阶段状态/连接门/错误页/iframe 全在一个 HTML 里——
   * webview 每次 `webview.html=` 重赋值都是整页 reload（数秒级），状态切换
   * 改用 postMessage 驱动，整个生命周期只加载一次。
   */
  private renderShell(initialStatus: string): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
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
  <script>
    (function () {
      const vscode = acquireVsCodeApi();
      const frame = document.getElementById('pi-web-frame');
      const gate = document.getElementById('gate');
      const gateText = document.getElementById('gate-text');
      const dots = '<span class="dots"><span>.</span><span>.</span><span>.</span></span>';
      let gen = 0;          // serverReady 代际：新一轮探测作废旧轮询
      let loadedUrl = '';   // iframe 已加载的地址

      vscode.postMessage({ source: 'piIde.log', text: 'shell painted' });

      function setStatus(text) {
        if (gate.classList.contains('error')) return;
        gateText.innerHTML = String(text) + dots;
      }

      function showFrame(url) {
        if (loadedUrl === url && frame.style.display === 'block') return;
        vscode.postMessage({ source: 'piIde.log', text: 'server probe passed, setting iframe.src' });
        loadedUrl = url;
        gateText.innerHTML = 'Connecting to local server' + dots;
        gate.style.display = 'grid';
        frame.src = url;
      }
      frame.addEventListener('load', function () {
        vscode.postMessage({ source: 'piIde.log', text: 'iframe page loaded' });
        gate.style.display = 'none';
        frame.style.display = 'block';
      });

      async function probeAndShow(url, probe, myGen) {
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline && gen === myGen) {
          try {
            await fetch(probe, { method: 'HEAD', mode: 'no-cors', cache: 'no-store' });
            if (gen !== myGen) return;
            showFrame(url);
            return;
          } catch (e) {
            await new Promise(function (r) { setTimeout(r, 1500); });
          }
        }
        if (gen !== myGen) return;
        gate.classList.add('error');
        vscode.postMessage({ source: 'piIde.log', text: '90s probe timeout, showing failure page' });
        gateText.innerHTML =
          'Cannot reach the Pi for IDE server.<br/>' +
          'Check the output panel (View → Output → Pi for IDE), or run "Pi for IDE: Stop Server" and retry.';
      }

      window.addEventListener('message', function (event) {
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        const p = data.payload || {};
        if (data.source === 'host' && p.kind === 'status') {
          setStatus(p.text);
        } else if (data.source === 'host' && p.kind === 'serverReady') {
          gate.classList.remove('error');
          if (loadedUrl === p.url && frame.style.display === 'block') return; // 已就绪，忽略
          setStatus('Connecting to local server');
          probeAndShow(p.url, p.probe, ++gen);
        } else if (data.source === 'host' && p.kind === 'serverError') {
          gen++;
          gate.classList.add('error');
          gate.style.display = 'grid';
          gateText.innerHTML = String(p.text);
        } else if (data.source === 'embed') {
          // iframe -> extension host. Forward the whole envelope (id + request).
          vscode.postMessage(data);
        } else if (data.source === 'host') {
          // extension host -> iframe. Forward responses and notifications.
          if (frame && frame.contentWindow) {
            frame.contentWindow.postMessage(data, '*');
          }
        }
      });
    })();
  </script>
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
