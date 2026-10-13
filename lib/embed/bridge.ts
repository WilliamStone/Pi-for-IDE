// Embed host bridge — pi-web 页面 ↔ 嵌入宿主（IDE wrapper 等）的通用协议。
//
// pi-web 作为独立 Next.js 应用运行不变。当页面被嵌入宿主容器（如 VSCode
// webview 的 <iframe>）中时，宿主在 URL 里带上 `?embed=<hostId>`，并在父
// 文档中转发本文件定义的消息。
//
// Communication path:
//   pi-web page (this file)
//     ──postMessage({ source: "embed", ... })──▶ window.parent (host wrapper)
//     ──宿主适配层转发到宿主能力实现（如 vscodeApi.postMessage()）
//     ◀──host replies──▶ window.parent
//     ──postMessage({ source: "host", ... })──▶ this window (message listener)
//
// The bridge is a no-op when not in embed mode (standalone browser visits),
// so nothing here can break the normal pi-web experience.

export interface EmbedOpenFileRequest {
  kind: "openFile";
  filePath: string;
  /** Optional 1-based line / line,col to reveal. */
  line?: number;
  column?: number;
  /** "source" | "preview" | "diff" — diff maps to the host's native diff view. */
  mode?: "source" | "preview" | "diff";
}

export interface EmbedCompleteAtRequest {
  kind: "completeAt";
  cwd: string;
  query: string;
}

export interface EmbedReadFileRequest {
  kind: "readFile";
  filePath: string;
}

export interface EmbedNotifyRequest {
  kind: "notify";
  message: string;
  level: "info" | "warning" | "error";
}

export interface EmbedMentionRequest {
  kind: "mention";
  /** 提及的文件，相对于宿主工作区根目录的相对路径（不含前导 ./）。 */
  relativePath: string;
  /** 可选的起止行号（1-based，闭区间）。不填则提及整文件。 */
  startLine?: number;
  endLine?: number;
  /** 选中的文本内容，会一并插入到聊天输入框作为上下文。 */
  selectedText?: string;
}

export interface EmbedClipboardReadRequest {
  kind: "clipboardRead";
}

/** 查询宿主当前活动编辑器文件（页面刷新后恢复状态用）。 */
export interface EmbedGetActiveEditorRequest {
  kind: "getActiveEditor";
}

export interface EmbedClipboardWriteRequest {
  kind: "clipboardWrite";
  text: string;
}

/**
 * 在系统默认浏览器中打开本应用。url 为页面当前地址（iframe 内加载的
 * 完整 URL），宿主会解析出 origin 再调用其打开外部链接的能力。
 */
export interface EmbedOpenInBrowserRequest {
  kind: "openInBrowser";
  url: string;
}

/**
 * 在新一轮 prompt 发出前，让宿主为本轮建一个文件快照。
 * 宿主只读 git status（不创建任何 git 对象）+ 读磁盘文件，存内存。
 * 必须在 prompt 到达 AgentSession 之前完成，否则 before 内容不准。
 */
export interface EmbedCaptureSnapshotRequest {
  kind: "captureSnapshot";
  /** 本轮 user message 的 entryId，作为快照标识。 */
  turnId: string;
  /** session 工作目录（绝对路径）。 */
  cwd: string;
}

/** 取某个文件在本轮快照里的 before 内容（纯只读）。 */
export interface EmbedGetBeforeContentRequest {
  kind: "getBeforeContent";
  turnId: string;
  filePath: string;
  cwd: string;
}

/**
 * 用宿主原生 diff 视图显示某文件的 before/after 对比。
 * before/after 直接传完整内容，宿主写临时文件后调其 diff 能力。
 */
export interface EmbedShowDiffRequest {
  kind: "showDiff";
  filePath: string;
  before: string;
  after: string;
  title?: string;
}

/** 回退：把指定文件恢复到本轮快照的内容（宿主侧直接写文件，不碰 git）。 */
export interface EmbedRevertFilesRequest {
  kind: "revertFiles";
  turnId: string;
  files: string[];
  cwd: string;
}

/** 回退 edit：宿主读磁盘当前内容，把每个 newText 换回 oldText（反向 apply）。 */
export interface EmbedRevertEditRequest {
  kind: "revertEdit";
  filePath: string;
  cwd: string;
  /** 原始 edits，反序 apply（后改的先换回）。 */
  edits: { oldText: string; newText: string }[];
}

export type EmbedRequest =
  | EmbedOpenFileRequest
  | EmbedCompleteAtRequest
  | EmbedReadFileRequest
  | EmbedNotifyRequest
  | EmbedMentionRequest
  | EmbedClipboardReadRequest
  | EmbedClipboardWriteRequest
  | EmbedGetActiveEditorRequest
  | EmbedCaptureSnapshotRequest
  | EmbedGetBeforeContentRequest
  | EmbedShowDiffRequest
  | EmbedRevertFilesRequest
  | EmbedRevertEditRequest
  | EmbedOpenInBrowserRequest;

export interface EmbedCompleteAtResponse {
  kind: "completeAt";
  matches: Array<{ path: string; isDir: boolean }>;
}

export interface EmbedReadFileResponse {
  kind: "readFile";
  content?: string;
  error?: string;
}

export interface EmbedClipboardReadResponse {
  kind: "clipboardRead";
  text: string;
}

/** 宿主当前活动编辑器。relativePath 为空表示无活动文件（非 file scheme）。 */
export interface EmbedGetActiveEditorResponse {
  kind: "getActiveEditor";
  relativePath: string | null;
  filePath: string | null;
}

export interface EmbedCaptureSnapshotResponse {
  kind: "captureSnapshot";
  success: boolean;
  message?: string;
}

export interface EmbedGetBeforeContentResponse {
  kind: "getBeforeContent";
  content: string | null;
}

export interface EmbedRevertFilesResponse {
  kind: "revertFiles";
  success: boolean;
  message?: string;
}

export interface EmbedRevertEditResponse {
  kind: "revertEdit";
  success: boolean;
  message?: string;
}

export type EmbedResponse =
  | EmbedCompleteAtResponse
  | EmbedReadFileResponse
  | EmbedClipboardReadResponse
  | EmbedGetActiveEditorResponse
  | EmbedCaptureSnapshotResponse
  | EmbedGetBeforeContentResponse
  | EmbedRevertFilesResponse
  | EmbedRevertEditResponse;

const EMBED_QUERY_KEY = "embed";
const MESSAGE_SOURCE_PAGE = "embed";
const MESSAGE_SOURCE_HOST = "host";

let cachedEmbedMode: boolean | null = null;

/**
 * True when pi-web is rendered inside an embed host container. Detected from
 * the `?embed=<hostId>` URL parameter (set by the host wrapper when it builds
 * the page URL) and cached for the lifetime of the page.
 */
export function isEmbedMode(): boolean {
  if (cachedEmbedMode !== null) return cachedEmbedMode;
  if (typeof window === "undefined") {
    cachedEmbedMode = false;
    return false;
  }
  try {
    const params = new URL(window.location.href).searchParams;
    cachedEmbedMode = Boolean(params.get(EMBED_QUERY_KEY));
  } catch {
    cachedEmbedMode = false;
  }
  return cachedEmbedMode;
}

/**
 * 当前宿主标识（`?embed=<hostId>` 的值，如 "vscode"）；非 embed 模式为 null。
 */
export function embedHostId(): string | null {
  if (!isEmbedMode() || typeof window === "undefined") return null;
  try {
    return new URL(window.location.href).searchParams.get(EMBED_QUERY_KEY);
  } catch {
    return null;
  }
}

// Resolvers waiting for host responses, keyed by request id.
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
    if (data.source !== MESSAGE_SOURCE_HOST) return;

    const id = data.id as string | undefined;
    if (id && pendingResponses.has(id)) {
      // A response to a request we sent.
      const resolver = pendingResponses.get(id)!;
      pendingResponses.delete(id);
      resolver(data.payload);
      return;
    }

    // An unsolicited notification from the host.
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
 * Send a request to the embed host and resolve with its response.
 * Rejects (with a timeout) if the host never replies — callers should treat
 * a rejection as "feature unavailable" and fall back gracefully.
 */
export function sendEmbedRequest<T = unknown>(request: EmbedRequest, timeoutMs = 5000): Promise<T> {
  if (!isEmbedMode() || typeof window === "undefined" || !window.parent) {
    return Promise.reject(new Error("Not in embed mode"));
  }
  ensureMessageListener();

  const id = `r${nextRequestId++}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingResponses.delete(id);
      reject(new Error(`Embed host bridge timeout: ${request.kind}`));
    }, timeoutMs);

    pendingResponses.set(id, (payload: unknown) => {
      clearTimeout(timer);
      resolve(payload as T);
    });

    try {
      window.parent.postMessage(
        { source: MESSAGE_SOURCE_PAGE, id, request },
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
 * Fire-and-forget notification to the embed host. No response expected.
 */
export function notifyEmbedHost(request: EmbedRequest): void {
  if (!isEmbedMode() || typeof window === "undefined" || !window.parent) return;
  try {
    window.parent.postMessage({ source: MESSAGE_SOURCE_PAGE, request }, "*");
  } catch {
    // Ignore — standalone mode / cross-origin restrictions.
  }
}

/**
 * Subscribe to unsolicited notifications from the embed host
 * (e.g. "open a file in the chat panel"). Returns an unsubscribe function.
 */
export function onEmbedHostNotification(listener: NotificationListener): () => void {
  ensureMessageListener();
  notificationListeners.add(listener);
  return () => notificationListeners.delete(listener);
}

/**
 * 查询宿主当前活动编辑器文件（页面刷新后恢复状态用）。
 * 返回相对宿主工作区路径（无活动文件时为 null）。
 */
export async function getActiveEditorViaHost(): Promise<{ relativePath: string | null; filePath: string | null }> {
  try {
    const res = await sendEmbedRequest<EmbedGetActiveEditorResponse>(
      { kind: "getActiveEditor" },
      2000,
    );
    return { relativePath: res?.relativePath ?? null, filePath: res?.filePath ?? null };
  } catch {
    return { relativePath: null, filePath: null };
  }
}

/**
 * 嵌入 iframe 跨源时 navigator.clipboard.readText 会被权限策略拒。
 * 改走桥接让宿主用其剪贴板能力读取系统剪贴板。
 */
export async function clipboardReadViaHost(): Promise<string> {
  const res = await sendEmbedRequest<EmbedClipboardReadResponse>(
    { kind: "clipboardRead" },
    2000,
  );
  return res?.text ?? "";
}

/**
 * 写剪贴板同样走宿主剪贴板能力，比跨源 iframe 的
 * navigator.clipboard.writeText 更可靠。
 */
export async function clipboardWriteViaHost(text: string): Promise<void> {
  await sendEmbedRequest<unknown>({ kind: "clipboardWrite", text }, 2000);
}

/**
 * 通知宿主在系统默认浏览器中打开本应用（fire-and-forget，无响应）。
 * 非 embed 模式下为 no-op，调用方应自行处理（如 window.open）。
 */
export function openInBrowserViaHost(url: string): void {
  notifyEmbedHost({ kind: "openInBrowser", url });
}

/**
 * 在新一轮 prompt 发出前建快照。必须在 AgentSession 收到 prompt 之前调用
 * （否则 agent 可能已经改了文件，before 不准）。返回是否成功。
 * 非 git 仓库返回 success=false。
 */
export async function captureSnapshotViaHost(turnId: string, cwd: string): Promise<boolean> {
  try {
    const res = await sendEmbedRequest<EmbedCaptureSnapshotResponse>(
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
export async function getBeforeContentViaHost(turnId: string, filePath: string, cwd: string): Promise<string | null> {
  try {
    const res = await sendEmbedRequest<EmbedGetBeforeContentResponse>(
      { kind: "getBeforeContent", turnId, filePath, cwd },
      5000,
    );
    return res?.content ?? null;
  } catch {
    return null;
  }
}

/**
 * 用宿主原生 diff 视图显示某文件的 before/after 对比。
 * before/after 传完整内容，宿主写临时文件后调其 diff 能力。
 */
export async function showDiffViaHost(filePath: string, before: string, after: string, title?: string): Promise<void> {
  try {
    await sendEmbedRequest<unknown>(
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
export async function revertFilesViaHost(turnId: string, files: string[], cwd: string): Promise<{ success: boolean; message?: string }> {
  try {
    const res = await sendEmbedRequest<EmbedRevertFilesResponse>(
      { kind: "revertFiles", turnId, files, cwd },
      10000,
    );
    return { success: res?.success ?? false, message: res?.message };
  } catch (e) {
    return { success: false, message: String(e) };
  }
}

/**
 * 回退 edit：宿主读磁盘当前内容，把每个 newText 换回 oldText（反序 apply）。
 * 纯文件写，零 git。返回是否成功。
 */
export async function revertEditViaHost(
  filePath: string,
  cwd: string,
  edits: { oldText: string; newText: string }[],
): Promise<{ success: boolean; message?: string }> {
  try {
    const res = await sendEmbedRequest<EmbedRevertEditResponse>(
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
 * 安装全局 document 级剪贴键拦截器。仅在 embed 模式下生效。
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
  if (!isEmbedMode() || typeof document === "undefined") return () => {};
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
      return; // 让 ChatInput 的 handleEmbedClipboardKeydown 接管
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

    void clipboardWriteViaHost(selectedText).catch(() => {
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
