// EventSource 代理——页面经 bridge 请求的事件流在扩展宿主（Node 进程）
// 建立并泵回 webview。webview 侧 Chromium 的 ~6 条/源 HTTP/1.1 连接池
// 因此一条长连接都不占：多少个可见面板都不再有池饥饿。
//
// 传输用 node:http(s).get——global agent maxSockets 默认 Infinity，
// 不受 undici fetch 每源 10 连接限制（扩展宿主也无法 require undici
// 调高其 dispatcher，所以不走 fetch）。
//
// 流的生命周期跟着面板页面代（pageId）走：页面每次装载发
// eventSourceInit，旧代的流全部 abort；迟到的旧代 open/close 被丢弃。
// 面板 dispose 同样清场。

import * as http from "node:http";
import * as https from "node:https";

export interface EventProxyResponseLike {
  status: number;
  location?: string;
  on(event: "data", cb: (chunk: Buffer) => void): void;
  on(event: "end", cb: () => void): void;
  on(event: "error", cb: (err: unknown) => void): void;
  resume(): void;
}

export interface EventProxyRequestLike {
  destroy(): void;
}

/** 传输注入点——单测喂桩；生产实现走 node:http/https。 */
export type EventProxyTransport = (opts: {
  url: string;
  headers: Record<string, string>;
  onResponse(res: EventProxyResponseLike): void;
  onError(err: unknown): void;
}) => EventProxyRequestLike;

export interface EventSourceProxyDeps {
  /** 发回页面的 {source:"host", payload} 通知载体。 */
  post(payload: Record<string, unknown>): void;
  log(line: string): void;
  transport?: EventProxyTransport;
}

const MAX_REDIRECTS = 3;

function nodeTransport(opts: {
  url: string;
  headers: Record<string, string>;
  onResponse(res: EventProxyResponseLike): void;
  onError(err: unknown): void;
}): EventProxyRequestLike {
  const mod = opts.url.startsWith("https:") ? https : http;
  const req = mod.get(opts.url, { headers: opts.headers }, (res) => {
    opts.onResponse({
      status: res.statusCode ?? 0,
      location: res.headers.location,
      on: (event, cb) => res.on(event, cb as never),
      resume: () => res.resume(),
    });
  });
  req.on("error", (err) => opts.onError(err));
  return { destroy: () => req.destroy() };
}

interface StreamEntry {
  req: EventProxyRequestLike;
  ended: boolean;
}

export class EventSourceProxy {
  private pageId: string | null = null;
  private readonly streams = new Map<string, StreamEntry>();
  private readonly transport: EventProxyTransport;
  private readonly deps: EventSourceProxyDeps;

  constructor(deps: EventSourceProxyDeps) {
    this.deps = deps;
    this.transport = deps.transport ?? nodeTransport;
  }

  /** eventSourceInit——新页面代接管，清掉旧代遗留的所有流。 */
  init(pageId: string): void {
    this.pageId = pageId;
    for (const id of [...this.streams.keys()]) this.abort(id, "page reloaded");
  }

  open(msg: { streamId?: unknown; url?: unknown; lastEventId?: unknown; pageId?: unknown }): void {
    const streamId = typeof msg.streamId === "string" ? msg.streamId : "";
    const url = typeof msg.url === "string" ? msg.url : "";
    if (!streamId || !url) return;
    if (this.pageId && typeof msg.pageId === "string" && msg.pageId !== this.pageId) {
      this.deps.log(`drop stale open ${streamId} (page ${msg.pageId} != ${this.pageId})`);
      return;
    }
    if (this.streams.has(streamId)) this.abort(streamId, "replaced");
    const lastEventId = typeof msg.lastEventId === "string" ? msg.lastEventId : undefined;
    this.deps.log(`open ${streamId} ${url}`);
    this.connect(streamId, url, lastEventId, 0);
  }

  close(msg: { streamId?: unknown; pageId?: unknown }): void {
    const streamId = typeof msg.streamId === "string" ? msg.streamId : "";
    if (!streamId) return;
    if (this.streams.has(streamId)) this.abort(streamId, "closed by page");
  }

  dispose(): void {
    for (const id of [...this.streams.keys()]) this.abort(id, "panel disposed");
  }

  private connect(streamId: string, url: string, lastEventId: string | undefined, redirects: number): void {
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      // 不声明 gzip——服务端见到 identity 回未压缩流，代理无需解压。
      "Accept-Encoding": "identity",
    };
    if (lastEventId) headers["Last-Event-ID"] = lastEventId;

    const entry: StreamEntry = { req: { destroy() {} }, ended: false };
    this.streams.set(streamId, entry);

    entry.req = this.transport({
      url,
      headers,
      onResponse: (res) => {
        if (entry.ended) return;
        if ([301, 302, 307, 308].includes(res.status) && res.location && redirects < MAX_REDIRECTS) {
          res.resume();
          this.streams.delete(streamId);
          this.connect(streamId, new URL(res.location, url).href, lastEventId, redirects + 1);
          return;
        }
        this.deps.post({ kind: "eventSourceOpen", streamId, status: res.status });
        if (res.status < 200 || res.status >= 300) {
          res.resume();
          this.finish(streamId, `HTTP ${res.status}`);
          return;
        }
        const decoder = new TextDecoder();
        res.on("data", (chunk) => {
          if (entry.ended) return;
          const text = decoder.decode(chunk, { stream: true });
          if (text) this.deps.post({ kind: "eventSourceData", streamId, chunk: text });
        });
        res.on("end", () => this.finish(streamId));
        res.on("error", (err) => this.finish(streamId, String(err)));
      },
      onError: (err) => this.finish(streamId, String(err)),
    });
  }

  private finish(streamId: string, error?: string): void {
    const entry = this.streams.get(streamId);
    if (!entry || entry.ended) return;
    entry.ended = true;
    this.streams.delete(streamId);
    this.deps.post({ kind: "eventSourceEnd", streamId, ...(error ? { error } : {}) });
  }

  private abort(streamId: string, reason: string): void {
    const entry = this.streams.get(streamId);
    if (!entry) return;
    entry.ended = true;
    this.streams.delete(streamId);
    try {
      entry.req.destroy();
    } catch {
      // 传输已死——忽略。
    }
    this.deps.log(`abort ${streamId} (${reason})`);
  }
}
