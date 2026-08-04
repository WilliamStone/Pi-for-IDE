// VSCode webview ↔ extension host bridge.
//
// PI Code runs unchanged as a standalone Next.js app. When it is loaded inside
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

export interface VsCodeClipboardReadRequest {
  kind: "clipboardRead";
}

/** 查询当前 VSCode 活动编辑器文件（webview 刷新后恢复状态用）。 */
export interface VsCodeGetActiveEditorRequest {
  kind: "getActiveEditor";
}

export interface VsCodeClipboardWriteRequest {
  kind: "clipboardWrite";
  text: string;
}

/**
 * 在系统默认浏览器中打开 PI Code。url 为页面当前地址（iframe 内加载的
 * 完整 URL），扩展宿会解析出 origin 再调用 vscode.env.openExternal。
 */
export interface VsCodeOpenInBrowserRequest {
  kind: "openInBrowser";
  url: string;
}

/**
 * 在新一轮 prompt 发出前，让扩展宿主为本轮建一个文件快照。
 * 扩展只读 git status（不创建任何 git 对象）+ 读磁盘文件，存内存。
 * 必须在 prompt 到达 AgentSession 之前完成，否则 before 内容不准。
 */
export interface VsCodeCaptureSnapshotRequest {
  kind: "captureSnapshot";
  /** 本轮 user message 的 entryId，作为快照标识。 */
  turnId: string;
  /** session 工作目录（绝对路径）。 */
  cwd: string;
}

/** 取某个文件在本轮快照里的 before 内容（纯只读）。 */
export interface VsCodeGetBeforeContentRequest {
  kind: "getBeforeContent";
  turnId: string;
  filePath: string;
  cwd: string;
}

/**
 * 用 VSCode 原生 diff 显示某文件的 before/after 对比。
 * before/after 直接传完整内容，扩展写到临时文件再调 vscode.diff。
 */
export interface VsCodeShowDiffRequest {
  kind: "showDiff";
  filePath: string;
  before: string;
  after: string;
  title?: string;
}

/** 回退：把指定文件恢复到本轮快照的内容（直接 fs.writeFile，不碰 git）。 */
export interface VsCodeRevertFilesRequest {
  kind: "revertFiles";
  turnId: string;
  files: string[];
  cwd: string;
}

/** 回退 edit：读磁盘当前内容，把每个 newText 换回 oldText（反向 apply）。 */
export interface VsCodeRevertEditRequest {
  kind: "revertEdit";
  filePath: string;
  cwd: string;
  /** 原始 edits，反序 apply（后改的先换回）。 */
  edits: { oldText: string; newText: string }[];
}

export type VsCodeRequest =
  | VsCodeOpenFileRequest
  | VsCodeCompleteAtRequest
  | VsCodeReadFileRequest
  | VsCodeNotifyRequest
  | VsCodeMentionRequest
  | VsCodeClipboardReadRequest
  | VsCodeClipboardWriteRequest
  | VsCodeGetActiveEditorRequest
  | VsCodeCaptureSnapshotRequest
  | VsCodeGetBeforeContentRequest
  | VsCodeShowDiffRequest
  | VsCodeRevertFilesRequest
  | VsCodeRevertEditRequest
  | VsCodeOpenInBrowserRequest;

export interface VsCodeCompleteAtResponse {
  kind: "completeAt";
  matches: Array<{ path: string; isDir: boolean }>;
}

export interface VsCodeReadFileResponse {
  kind: "readFile";
  content?: string;
  error?: string;
}

export interface VsCodeClipboardReadResponse {
  kind: "clipboardRead";
  text: string;
}

/** 当前 VSCode 活动编辑器。relativePath 为空表示无活动文件（非 file scheme）。 */
export interface VsCodeGetActiveEditorResponse {
  kind: "getActiveEditor";
  relativePath: string | null;
  filePath: string | null;
}

export interface VsCodeCaptureSnapshotResponse {
  kind: "captureSnapshot";
  success: boolean;
  message?: string;
}

export interface VsCodeGetBeforeContentResponse {
  kind: "getBeforeContent";
  content: string | null;
}

export interface VsCodeRevertFilesResponse {
  kind: "revertFiles";
  success: boolean;
  message?: string;
}

export interface VsCodeRevertEditResponse {
  kind: "revertEdit";
  success: boolean;
  message?: string;
}

export type VsCodeResponse =
  | VsCodeCompleteAtResponse
  | VsCodeReadFileResponse
  | VsCodeClipboardReadResponse
  | VsCodeGetActiveEditorResponse
  | VsCodeCaptureSnapshotResponse
  | VsCodeGetBeforeContentResponse
  | VsCodeRevertFilesResponse
  | VsCodeRevertEditResponse;

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

/**
 * 查询当前 VSCode 活动编辑器文件（webview 刷新后恢复状态用）。
 * 返回相对工作区路径（无活动文件时为 null）。
 */
export async function getActiveEditorViaVsCode(): Promise<{ relativePath: string | null; filePath: string | null }> {
  try {
    const res = await sendVsCodeRequest<VsCodeGetActiveEditorResponse>(
      { kind: "getActiveEditor" },
      2000,
    );
    return { relativePath: res?.relativePath ?? null, filePath: res?.filePath ?? null };
  } catch {
    return { relativePath: null, filePath: null };
  }
}

/**
 * VSCode webview iframe 跨源时 navigator.clipboard.readText 会被权限策略拒。
 * 改走桥接让扩展宿调 vscode.env.clipboard.readText()。
 */
export async function clipboardReadViaVsCode(): Promise<string> {
  const res = await sendVsCodeRequest<VsCodeClipboardReadResponse>(
    { kind: "clipboardRead" },
    2000,
  );
  return res?.text ?? "";
}

/**
 * 写剪贴板同样走 vscode.env.clipboard.writeText()，比跨源 iframe 的
 * navigator.clipboard.writeText 更可靠。
 */
export async function clipboardWriteViaVsCode(text: string): Promise<void> {
  await sendVsCodeRequest<unknown>({ kind: "clipboardWrite", text }, 2000);
}

/**
 * 通知扩展宿主在系统默认浏览器中打开 PI Code（fire-and-forget，无响应）。
 * 非 VSCode 模式下为 no-op，调用方应自行处理（如 window.open）。
 */
export function openInBrowserViaVsCode(url: string): void {
  notifyVsCode({ kind: "openInBrowser", url });
}

/**
 * 在新一轮 prompt 发出前建快照。必须在 AgentSession 收到 prompt 之前调用
 * （否则 agent 可能已经改了文件，before 不准）。返回是否成功。
 * 非 git 仓库返回 success=false。
 */
export async function captureSnapshotViaVsCode(turnId: string, cwd: string): Promise<boolean> {
  try {
    const res = await sendVsCodeRequest<VsCodeCaptureSnapshotResponse>(
      { kind: "captureSnapshot", turnId, cwd },
      5000,
    );
    return res?.success ?? false;
  } catch {
    return false;
  }
}

/**
 * 取某文件在本轮快照里的 before 内容。返回 null 表示无快照且非 git 仓库。
 * 用于 write/bash 等无 diff 的工具调用取 before。
 */
export async function getBeforeContentViaVsCode(turnId: string, filePath: string, cwd: string): Promise<string | null> {
  try {
    const res = await sendVsCodeRequest<VsCodeGetBeforeContentResponse>(
      { kind: "getBeforeContent", turnId, filePath, cwd },
      5000,
    );
    return res?.content ?? null;
  } catch {
    return null;
  }
}

/**
 * 用 VSCode 原生 diff 显示某文件的 before/after 对比。
 * before/after 传完整内容，扩展写临时文件后调 vscode.diff。
 */
export async function showDiffViaVsCode(filePath: string, before: string, after: string, title?: string): Promise<void> {
  try {
    await sendVsCodeRequest<unknown>(
      { kind: "showDiff", filePath, before, after, title },
      5000,
    );
  } catch {
    // 跱底：失败时静默
  }
}

/**
 * 回退：把指定文件恢复到本轮快照内容。返回是否成功。
 */
export async function revertFilesViaVsCode(turnId: string, files: string[], cwd: string): Promise<{ success: boolean; message?: string }> {
  try {
    const res = await sendVsCodeRequest<VsCodeRevertFilesResponse>(
      { kind: "revertFiles", turnId, files, cwd },
      10000,
    );
    return { success: res?.success ?? false, message: res?.message };
  } catch (e) {
    return { success: false, message: String(e) };
  }
}

/**
 * 回退 edit：读磁盘当前内容，把每个 newText 换回 oldText（反序 apply）。
 * 纯 fs，零 git。返回是否成功。
 */
export async function revertEditViaVsCode(
  filePath: string,
  cwd: string,
  edits: { oldText: string; newText: string }[],
): Promise<{ success: boolean; message?: string }> {
  try {
    const res = await sendVsCodeRequest<VsCodeRevertEditResponse>(
      { kind: "revertEdit", filePath, cwd, edits },
      10000,
    );
    return { success: res?.success ?? false, message: res?.message };
  } catch (e) {
    return { success: false, message: String(e) };
  }
}

/**
 * 判断当前焦点元素是否是文本输入控件（textarea/input/contenteditable）。
 * 用于全局剪贴键拦截器决定是否跳过——是输入控件则让 ChatInput 等组件
 * 自己的 onKeyDown 接管精确的复制/粘贴/剪切/全选逻辑。
 */
function isTextInputElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT") return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * 安装全局 document 级剪贴键拦截器。仅在 VSCode 模式下生效。
 *
 * 焦点在文本输入控件（textarea/input/contenteditable）时**跳过**，
 * 让 ChatInput 等组件自己的 onKeyDown 接管（它们处理选区、光标、粘贴插入
 * 更精确）。焦点在普通文本上时，这里截住 Cmd/Ctrl+C/X/A：
 *   - C/X：读 window.getSelection() 选中文本 → 写系统剪贴板（剪切再删选中）
 *   - A：selectAll
 *   - V：非输入焦点时无意义，不拦截
 *
 * 用 capture 阶段，确保在子组件的 onKeyDown 之前拿到事件。
 */
let globalInterceptorInstalled = false;

export function installGlobalClipboardInterceptor(): () => void {
  if (!isVsCodeMode() || typeof document === "undefined") return () => {};
  if (globalInterceptorInstalled) return () => {};
  globalInterceptorInstalled = true;

  const CLIP_COPY_KEYS = new Set(["c", "x", "a"]);

  const onKeyDown = (e: KeyboardEvent) => {
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return;
    const k = e.key.toLowerCase();
    if (!CLIP_COPY_KEYS.has(k)) return;
    // 输入法组合中不拦截。
    if (e.isComposing || e.keyCode === 229) return;

    // 焦点在文本输入控件时跳过——交给组件自己的 onKeyDown 处理。
    // 但要先判断是否真的在输入控件内，避免 textarea 的 Cmd+C 走这里而
    // 丢失精确的选区复制。
    const target = e.target;
    if (isTextInputElement(target)) {
      return; // 让 ChatInput 的 handleVsCodeClipboardKeydown 接管
    }

    e.preventDefault();
    e.stopPropagation();

    if (k === "a") {
      // 全选当前焦点元素；无可选时全选整个文档。
      const sel = window.getSelection();
      if (sel) {
        sel.selectAllChildren(document.body);
      }
      return;
    }

    // k === "c" || k === "x"
    const selection = window.getSelection();
    const selectedText = selection ? selection.toString() : "";
    if (!selectedText) return;

    void clipboardWriteViaVsCode(selectedText).catch(() => {
      try { void navigator.clipboard?.writeText(selectedText); } catch { /* ignore */ }
    });

    if (k === "x") {
      // 删除选中的 DOM 节点。document.execCommand('delete') 是最可靠的
      // contenteditable 删除方式；对非可编辑选区无副作用。
      try {
        if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
          const range = selection.getRangeAt(0);
          // 只删除可编辑区域内的选区，避免误删页面结构。
          const container = range.commonAncestorContainer;
          if (container.parentElement?.isContentEditable ||
              (container instanceof HTMLElement && container.isContentEditable)) {
            document.execCommand("delete");
          }
        }
      } catch {
        // 非可编辑区域剪切无意义，忽略。
      }
    }
  };

  document.addEventListener("keydown", onKeyDown, true);
  return () => {
    document.removeEventListener("keydown", onKeyDown, true);
    globalInterceptorInstalled = false;
  };
}
