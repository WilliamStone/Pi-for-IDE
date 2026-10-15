import * as vscode from "vscode";
import type { PiIdeServer } from "./piIdeServer";
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

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getServer: () => Promise<PiIdeServer | undefined>,
    private readonly ensureServer: () => Promise<PiIdeServer | undefined>,
    private readonly bridge: Bridge,
  ) {
    super(() => this.dispose());
  }

  /**
   * Reveal the panel in the given column, (re)loading it with `cwd` if the
   * cwd changed or the panel was disposed.
   */
  async reveal(cwd: string, viewColumn: vscode.ViewColumn): Promise<void> {
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
        "pi for IDE",
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

      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.currentCwd = undefined;
        // 缓存随面板销毁失效——新面板必须重新渲染 HTML，否则
        // 同实例同 URL 的提前返回会让新 webview 永久空白。
        this.lastServer = undefined;
        this.lastUrl = undefined;
      });

      // Bridge messages from the pi-web iframe to VSCode APIs and relay
      // responses back. Messages arrive as { source: "embed", id, request }.
      this.panel.webview.onDidReceiveMessage(async (message) => {
        if (!message || message.source !== "embed") return;
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

    let server = await this.getServer();
    if (!server) {
      // Try to start it now (covers the case where the user opened the panel
      // before piIde.start finished).
      server = await this.ensureServer();
    }

    const title = this.currentCwd ? `pi for IDE — ${shortPath(this.currentCwd)}` : "pi for IDE";
    this.panel.title = title;

    if (!server) {
      this.lastServer = undefined;
      this.lastUrl = undefined;
      this.panel.webview.html = this.renderError(
        "pi for IDE 服务器启动失败。详情请见输出面板（查看 → 输出 → pi for IDE）。",
      );
      return;
    }

    const url = new URL(server.origin);
    url.searchParams.set("embed", "vscode");
    if (this.currentCwd) url.searchParams.set("cwd", this.currentCwd);
    const urlStr = url.toString();

    // 服务器实例与 URL 都没变就不重渲染——避免每次点状态栏都重载 iframe
    // 丢失页面状态；stop 后再 start 实例必变，iframe 会重新指向。
    if (server === this.lastServer && urlStr === this.lastUrl) return;
    this.lastServer = server;
    this.lastUrl = urlStr;
    this.panel.webview.html = this.renderHtml(urlStr);
  }

  private renderHtml(piWebUrl: string): string {
    // The bridge script must run before the iframe loads so it can attach a
    // message listener. A single listener routes by `source`:
    //   "embed" -> forward to extension host via vscode.postMessage
    //   "host"  -> forward to iframe via iframe.contentWindow.postMessage
    const serverOrigin = new URL(piWebUrl).origin;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>pi for IDE</title>
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
    <h1>pi for IDE</h1>
    <p id="gate-text">正在连接本地服务器<span class="dots"><span>.</span><span>.</span><span>.</span></span></p>
  </main></div>
  <iframe id="pi-web-frame" title="pi for IDE" style="display:none"></iframe>
  <script>
    (function () {
      const vscode = acquireVsCodeApi();
      const frame = document.getElementById('pi-web-frame');
      const gate = document.getElementById('gate');
      const gateText = document.getElementById('gate-text');
      const piWebUrl = ${JSON.stringify(piWebUrl)};
      const probeUrl = ${JSON.stringify(serverOrigin)};
      const deadline = Date.now() + 90000;

      function showFrame() {
        frame.src = piWebUrl;
        frame.addEventListener('load', function () {
          gate.style.display = 'none';
          frame.style.display = 'block';
        });
      }

      // 轮询服务器可达性（no-cors：响应体读不了，但"请求被响应"本身就是
      // 服务器已监听的信号）；90s 仍不通才显示真错误。
      (async function waitForServer() {
        while (Date.now() < deadline) {
          try {
            await fetch(probeUrl, { method: 'HEAD', mode: 'no-cors', cache: 'no-store' });
            showFrame();
            return;
          } catch (e) {
            await new Promise(function (r) { setTimeout(r, 1500); });
          }
        }
        gate.classList.add('error');
        gateText.innerHTML =
          '无法连接 pi for IDE 服务器。<br/>' +
          '请查看输出面板（查看 → 输出 → pi for IDE），或执行命令 "pi for IDE: 停止服务器" 后重试。';
      })();

      window.addEventListener('message', function (event) {
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        if (data.source === 'embed') {
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

  private renderError(message: string): string {
    return /* html */ `<!DOCTYPE html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; color: #e8e8e8; background: #1a1a1a; padding: 24px;">
<h2 style="color:#f87171;">pi for IDE</h2>
<p>${message}</p>
</body></html>`;
  }
}

function shortPath(p: string): string {
  // Shorten /Users/xdf/mine-code/pi-code -> ~/mine-code/pi-code for the tab title.
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}
