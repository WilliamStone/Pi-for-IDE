// Embed EventSource 代理——embed 模式下把 window.EventSource 换成经宿主
// 桥接的实现：实际 HTTP 连接在宿主（Node/Electron 扩展宿主进程）侧建立，
// Chromium webview 的 ~6 条/源 HTTP/1.1 连接池一条都不占。所有 SSE 消费方
// （会话事件、FileViewer watch、终端事件、登录轮询以及未来的）透明受益，
// 调用点零改动。
//
// 协议（全部走 lib/embed/bridge.ts 的消息通道）：
//   page→host  {kind:"eventSourceInit",  pageId}               模块装载时一次，
//                                                              宿主清掉上一代页面的流
//   page→host  {kind:"eventSourceOpen",  streamId,url,pageId,lastEventId?}
//   page→host  {kind:"eventSourceClose", streamId,pageId}
//   host→page  {kind:"eventSourceOpen",  streamId,status}      响应头到达
//   host→page  {kind:"eventSourceData",  streamId,chunk}       SSE 原始文本段
//   host→page  {kind:"eventSourceEnd",   streamId,error?}      流结束/失败
//
// 语义对齐原生 EventSource：具名 event: 字段按类型派发、data: 多行拼接、
// id:/retry: 字段生效、断流后按 retry 间隔带 Last-Event-ID 自动重连；
// HTTP 非 2xx 属终态（CLOSED + error，不重连），网络类失败重连。
//
// 安装门控：?evProxy=1（宿主在 embedUrl 里声明支持）——旧宿主不发该参数，
// 页面自动回退原生 EventSource，新页面配旧扩展不回归。

import {
  isEmbedMode,
  embedParam,
  notifyEmbedHost,
  onEmbedHostNotification,
  type EmbedRequest,
} from "./bridge";

export interface EventSourceProxyDeps {
  /** 本页面代的标识（页面每次装载重新生成）。 */
  pageId: string;
  notify(request: EmbedRequest): void;
  subscribe(listener: (payload: { kind: string; [key: string]: unknown }) => void): () => void;
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;
const DEFAULT_RETRY_MS = 3000;

type EventListener = (event: { type: string; [key: string]: unknown }) => void;

/** MessageEvent/Event 在测试宿主（node --test）里不存在——优先用原生构造，否则退普通对象。 */
function makeEvent(type: string, init?: Record<string, unknown>): { type: string; [key: string]: unknown } {
  if (typeof MessageEvent === "function") {
    try {
      return new MessageEvent(type, init) as unknown as { type: string };
    } catch {
      // fall through
    }
  }
  return { type, ...(init ?? {}) };
}

function makeSimpleEvent(type: string): { type: string } {
  if (typeof Event === "function") {
    try {
      return new Event(type) as unknown as { type: string };
    } catch {
      // fall through
    }
  }
  return { type };
}

/**
 * 构造一个 EventSource 兼容类——依赖注入版（bridge 通道在调用方绑定），
 * 既给生产安装用，也给单测注入桩用。
 */
export function createProxiedEventSourceClass(deps: EventSourceProxyDeps) {
  const live = new Map<string, ProxiedEventSourceImpl>();
  let subscribed = false;
  let counter = 0;

  const ensureSubscription = () => {
    if (subscribed) return;
    subscribed = true;
    deps.subscribe((payload) => {
      const streamId = payload.streamId;
      if (typeof streamId !== "string") return;
      live.get(streamId)?.handleHost(payload);
    });
  };

  class ProxiedEventSourceImpl {
    static readonly CONNECTING = CONNECTING;
    static readonly OPEN = OPEN;
    static readonly CLOSED = CLOSED;
    readonly CONNECTING = CONNECTING;
    readonly OPEN = OPEN;
    readonly CLOSED = CLOSED;

    readonly url: string;
    readonly withCredentials: boolean;
    readyState: number = CONNECTING;

    onopen: EventListener | null = null;
    onmessage: EventListener | null = null;
    onerror: EventListener | null = null;

    private readonly streamId: string;
    private readonly listeners = new Map<string, Set<EventListener>>();
    private buffer = "";
    private dataBuffer = "";
    private pendingType = "";
    private lastEventId = "";
    private retryMs = DEFAULT_RETRY_MS;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private closedFlag = false;
    /** HTTP 非 2xx 收到的终态——end 到达时不再触发重连。 */
    private failedTerminally = false;

    constructor(url: string | URL, init?: { withCredentials?: boolean }) {
      this.url = new URL(
        String(url),
        typeof window !== "undefined" ? window.location.href : undefined,
      ).href;
      this.withCredentials = init?.withCredentials ?? false;
      this.streamId = `es${++counter}`;
      ensureSubscription();
      live.set(this.streamId, this);
      this.open();
    }

    addEventListener(type: string, listener: EventListener | null): void {
      if (!listener) return;
      let set = this.listeners.get(type);
      if (!set) this.listeners.set(type, (set = new Set()));
      set.add(listener);
    }

    removeEventListener(type: string, listener: EventListener | null): void {
      this.listeners.get(type)?.delete(listener as EventListener);
    }

    dispatchEvent(event: { type: string }): boolean {
      this.dispatch(event.type, event);
      return true;
    }

    close(): void {
      if (this.closedFlag) return;
      this.closedFlag = true;
      this.readyState = CLOSED;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      live.delete(this.streamId);
      deps.notify({ kind: "eventSourceClose", streamId: this.streamId, pageId: deps.pageId });
    }

    private open(): void {
      this.readyState = CONNECTING;
      deps.notify({
        kind: "eventSourceOpen",
        streamId: this.streamId,
        url: this.url,
        lastEventId: this.lastEventId || undefined,
        pageId: deps.pageId,
      });
    }

    handleHost(payload: { kind: string; [key: string]: unknown }): void {
      if (this.closedFlag) return;
      if (payload.kind === "eventSourceOpen") {
        const status = typeof payload.status === "number" ? payload.status : 0;
        if (status >= 200 && status < 300) {
          this.readyState = OPEN;
          this.dispatch("open", makeSimpleEvent("open"));
        } else {
          // 终态失败：与原生行为一致——CLOSED + error，不再重连。
          this.failedTerminally = true;
          this.readyState = CLOSED;
          this.dispatch("error", makeSimpleEvent("error"));
        }
      } else if (payload.kind === "eventSourceData") {
        if (typeof payload.chunk === "string" && payload.chunk) {
          this.buffer += payload.chunk;
          this.drain();
        }
      } else if (payload.kind === "eventSourceEnd") {
        if (this.failedTerminally) {
          this.closedFlag = true;
          live.delete(this.streamId);
          return;
        }
        this.readyState = CONNECTING;
        this.dispatch("error", makeSimpleEvent("error"));
        this.scheduleReconnect();
      }
    }

    private scheduleReconnect(): void {
      if (this.retryTimer) return;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (!this.closedFlag) this.open();
      }, this.retryMs);
    }

    /** SSE 行解析（WHATWG：\r\n / \r / \n 均算行尾；未完结的行留在 buffer）。 */
    private drain(): void {
      for (;;) {
        const m = /\r\n|[\r\n]/.exec(this.buffer);
        if (!m) return;
        const line = this.buffer.slice(0, m.index);
        this.buffer = this.buffer.slice(m.index + m[0].length);
        if (line === "") {
          this.dispatchBuffered();
          continue;
        }
        if (line.startsWith(":")) continue; // comment
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") this.pendingType = value;
        else if (field === "data") this.dataBuffer += value + "\n";
        else if (field === "id") {
          // SSE 规范：id 值含 NUL 时忽略整个字段。
          if (!value.includes(String.fromCharCode(0))) this.lastEventId = value;
        } else if (field === "retry") {
          if (/^\d+$/.test(value)) this.retryMs = Number(value);
        }
      }
    }

    private dispatchBuffered(): void {
      const data = this.dataBuffer;
      const type = this.pendingType || "message";
      this.dataBuffer = "";
      this.pendingType = "";
      if (!data) return;
      this.dispatch(type, makeEvent(type, {
        data: data.slice(0, -1),
        lastEventId: this.lastEventId,
      }));
    }

    private dispatch(type: string, event: { type: string; [key: string]: unknown }): void {
      const named = this.listeners.get(type);
      if (named) for (const l of [...named]) safeCall(l, event);
      const prop = (type === "open" ? this.onopen
        : type === "message" ? this.onmessage
        : type === "error" ? this.onerror
        : null);
      if (prop) safeCall(prop, event);
    }
  }

  function safeCall(listener: EventListener, event: { type: string; [key: string]: unknown }): void {
    try {
      listener(event);
    } catch {
      // 监听器异常不拖垮其余监听器（与 DOM dispatch 语义一致）。
    }
  }

  return ProxiedEventSourceImpl as unknown as typeof EventSource;
}

let installed = false;

/**
 * embed 模式下替换 window.EventSource。幂等；非 embed / 宿主未声明
 * evProxy 能力时不替换（回退原生实现，对旧版宿主零回归）。
 */
export function installEmbedEventSource(): void {
  if (installed || typeof window === "undefined") return;
  if (!isEmbedMode() || embedParam("evProxy") !== "1") return;
  installed = true;
  const pageId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `p${Date.now()}-${Math.random().toString(36).slice(2)}`;
  notifyEmbedHost({ kind: "eventSourceInit", pageId });
  const Proxied = createProxiedEventSourceClass({
    pageId,
    notify: notifyEmbedHost,
    subscribe: onEmbedHostNotification,
  });
  // 显式标记——生产构建会 minify 类名，诊断/e2e 用稳定属性判断替身已装。
  (Proxied as unknown as Record<string, unknown>).__piProxied = true;
  window.EventSource = Proxied;
}

// 模块副作用安装——本模块须在首个 new EventSource 调用前被 import
// （AppShell 以副作用方式引入）。
installEmbedEventSource();
