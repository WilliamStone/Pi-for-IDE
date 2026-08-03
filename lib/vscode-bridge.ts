// VSCode webview ↔ extension host bridge.
//
// Pi Web runs unchanged as a standalone Next.js app. When it is loaded inside
// a VSCode webview, the extension passes `?vscode=1` in the URL and hosts the
// page inside an <iframe> whose parent document owns acquireVsCodeApi().
//
// Communication path:
//   pi-web page (this file)
//     ──postMessage({ source: "pi-web", ... })──▶ window.parent (extension webview)
//     ──forwards to extension host via vscodeApi.postMessage()
//     ◀──extension host replies──▶ window.parent
//     ──postMessage({ source: "vscode", ... })──▶ this window (message listener)
//
// The bridge is a no-op when not in VSCode mode (standalone browser visits),
// so nothing here can break the normal pi-web experience.

export interface VsCodeOpenFileRequest {
  kind: "openFile";
  filePath: string;
  /** Optional 1-based line / line,col to reveal. */
  line?: number;
  column?: number;
  /** "source" | "preview" | "diff" — preview/diff map to VSCode's side-by-side. */
  mode?: "source" | "preview" | "diff";
}

export interface VsCodeCompleteAtRequest {
  kind: "completeAt";
  cwd: string;
  query: string;
}

export interface VsCodeReadFileRequest {
  kind: "readFile";
  filePath: string;
}

export interface VsCodeNotifyRequest {
  kind: "notify";
  message: string;
  level: "info" | "warning" | "error";
}

export interface VsCodeMentionRequest {
  kind: "mention";
  /** 提及的文件，相对于工作区根目录的相对路径（不含前导 ./）。 */
  relativePath: string;
  /** 可选的起止行号（1-based，闭区间）。不填则提及整文件。 */
  startLine?: number;
  endLine?: number;
  /** 选中的文本内容，会一并插入到聊天输入框作为上下文。 */
  selectedText?: string;
}

export type VsCodeRequest =
  | VsCodeOpenFileRequest
  | VsCodeCompleteAtRequest
  | VsCodeReadFileRequest
  | VsCodeNotifyRequest
  | VsCodeMentionRequest;

export interface VsCodeCompleteAtResponse {
  kind: "completeAt";
  matches: Array<{ path: string; isDir: boolean }>;
}

export interface VsCodeReadFileResponse {
  kind: "readFile";
  content?: string;
  error?: string;
}

export type VsCodeResponse = VsCodeCompleteAtResponse | VsCodeReadFileResponse;

const VSCODE_QUERY_KEY = "vscode";
const MESSAGE_SOURCE_PI_WEB = "pi-web";
const MESSAGE_SOURCE_VSCODE = "vscode";

let cachedVsCodeMode: boolean | null = null;

/**
 * True when pi-web is rendered inside a VSCode webview. Detected from the
 * `?vscode=1` URL parameter (set by the extension when it builds the webview
 * URL) and cached for the lifetime of the page.
 */
export function isVsCodeMode(): boolean {
  if (cachedVsCodeMode !== null) return cachedVsCodeMode;
  if (typeof window === "undefined") {
    cachedVsCodeMode = false;
    return false;
  }
  try {
    const params = new URL(window.location.href).searchParams;
    cachedVsCodeMode = params.get(VSCODE_QUERY_KEY) === "1";
  } catch {
    cachedVsCodeMode = false;
  }
  return cachedVsCodeMode;
}

// Resolvers waiting for extension-host responses, keyed by request id.
type ResponseResolver = (response: unknown) => void;
const pendingResponses = new Map<string, ResponseResolver>();
let nextRequestId = 1;

// Listeners for unsolicited notifications (e.g. "session opened a file").
type NotificationListener = (message: { kind: string; [key: string]: unknown }) => void;
const notificationListeners = new Set<NotificationListener>();

let messageListenerInstalled = false;

function ensureMessageListener(): void {
  if (typeof window === "undefined") return;
  if (messageListenerInstalled) return;
  messageListenerInstalled = true;

  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.source !== MESSAGE_SOURCE_VSCODE) return;

    const id = data.id as string | undefined;
    if (id && pendingResponses.has(id)) {
      // A response to a request we sent.
      const resolver = pendingResponses.get(id)!;
      pendingResponses.delete(id);
      resolver(data.payload);
      return;
    }

    // An unsolicited notification from the extension host.
    if (data.payload && typeof data.payload === "object" && "kind" in (data.payload as object)) {
      const payload = data.payload as { kind: string };
      for (const listener of notificationListeners) {
        try {
          listener(payload);
        } catch {
          // Ignore listener errors so one bad subscriber cannot break others.
        }
      }
    }
  });
}

/**
 * Send a request to the extension host and resolve with its response.
 * Rejects (with a timeout) if the host never replies — callers should treat
 * a rejection as "feature unavailable" and fall back gracefully.
 */
export function sendVsCodeRequest<T = unknown>(request: VsCodeRequest, timeoutMs = 5000): Promise<T> {
  if (!isVsCodeMode() || typeof window === "undefined" || !window.parent) {
    return Promise.reject(new Error("Not in VSCode mode"));
  }
  ensureMessageListener();

  const id = `r${nextRequestId++}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingResponses.delete(id);
      reject(new Error(`VSCode bridge timeout: ${request.kind}`));
    }, timeoutMs);

    pendingResponses.set(id, (payload: unknown) => {
      clearTimeout(timer);
      resolve(payload as T);
    });

    try {
      window.parent.postMessage(
        { source: MESSAGE_SOURCE_PI_WEB, id, request },
        "*",
      );
    } catch (error) {
      clearTimeout(timer);
      pendingResponses.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Fire-and-forget notification to the extension host. No response expected.
 */
export function notifyVsCode(request: VsCodeRequest): void {
  if (!isVsCodeMode() || typeof window === "undefined" || !window.parent) return;
  try {
    window.parent.postMessage({ source: MESSAGE_SOURCE_PI_WEB, request }, "*");
  } catch {
    // Ignore — standalone mode / cross-origin restrictions.
  }
}

/**
 * Subscribe to unsolicited notifications from the extension host
 * (e.g. "open a file in the chat panel"). Returns an unsubscribe function.
 */
export function onVsCodeNotification(listener: NotificationListener): () => void {
  ensureMessageListener();
  notificationListeners.add(listener);
  return () => notificationListeners.delete(listener);
}
