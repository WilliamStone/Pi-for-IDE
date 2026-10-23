// 生命周期主权：embed 拉起的服务器自己看时钟决定生死。
// 规范见 docs/agents/embed-protocol.md——presence = 扩展心跳 ∪ 开着的客户端
// 连接（SSE），两者都静默超过 T 才退出；仅当宿主 spawn 时注入
// PI_WEB_EMBED_WATCHDOG=1 才武装（独立运行的 Pi Web+ 永不自杀）。

interface EmbedLifecycleState {
  lastHeartbeat: number;
  lastActivity: number;
  openStreams: number;
  lastTick: number;
  timer: ReturnType<typeof setInterval> | null;
  shutdownHooks: Set<() => void>;
  shuttingDown: boolean;
  /** 有心跳的宿主客户端：clientId → 最近心跳时刻。匿名（无 id）归入 "" 桶。 */
  clients: Map<string, number>;
}

const STATE_KEY = Symbol.for("pi-web.embedLifecycle");

function lifecycleState(): EmbedLifecycleState {
  const g = globalThis as Record<symbol, EmbedLifecycleState | undefined>;
  return (g[STATE_KEY] ??= {
    lastHeartbeat: Date.now(),
    lastActivity: Date.now(),
    openStreams: 0,
    lastTick: Date.now(),
    timer: null,
    shutdownHooks: new Set(),
    shuttingDown: false,
    clients: new Map(),
  });
}

export function embedWatchdogArmed(): boolean {
  return process.env.PI_WEB_EMBED_WATCHDOG === "1";
}

function watchdogTimeoutMs(): number {
  const sec = Number(process.env.PI_WEB_EMBED_WATCHDOG_TIMEOUT_SEC ?? "");
  return (Number.isFinite(sec) && sec >= 15 ? sec : 90) * 1000;
}

const TICK_MS = 15_000;
// 一拍晚这么多只能是进程/机器挂起过，不是客户端消失——漂移时重置静默
// 计时，给扩展留一个完整窗口重新心跳（睡眠宽恕，见协议文档）。
const DRIFT_MS = TICK_MS * 2.5;

export function recordEmbedHeartbeat(clientId = ""): void {
  const s = lifecycleState();
  s.lastHeartbeat = Date.now();
  s.clients.set(clientId, s.lastHeartbeat);
}

/** 心跳活跃窗口：超 3×15s 不报到的 id 自动过期（窗口死了不拦关停）。 */
const CLIENT_STALE_MS = 45_000;

export function activeEmbedClients(): string[] {
  const s = lifecycleState();
  const now = Date.now();
  const out: string[] = [];
  for (const [id, at] of s.clients) {
    if (now - at <= CLIENT_STALE_MS) out.push(id);
    else s.clients.delete(id); // 顺手清陈旧条目
  }
  return out;
}

/**
 * shutdown 许可判据：存在"可证明的另一个使用方"才拒绝——旧版宿主
 * （≠判据 + attach 也 stop 的谋杀链）对一个共享服务器发 POST 时，
 * 若另一（新）窗的心跳还在，拒绝让它谋杀失败。
 * - 具名请求 {client:X}：有任何 *别的* 活跃 id（含匿名桶）→ 拒；
 * - 匿名请求（旧版无 client 字段）：有任何*具名* id → 拒；只有
 *   匿名桶 → 放行（老单窗显式 Stop 语义保留）。老+老混杀不可区分
 *   （同一 "" 桶）——属旧代码自身一致性，不归服务端兜底。
 */
export function embedShutdownAllowed(clientId: string | undefined): {
  allowed: boolean;
  others: number;
} {
  const requester = clientId ?? "";
  const others = activeEmbedClients().filter((id) => id !== requester).length;
  return { allowed: others === 0, others };
}

/** 任何常规 API 轮询（如 agent/running）也算客户端在场——覆盖只挂着
 *  列表页、没开 SSE 的浏览器页。 */
export function recordClientActivity(): void {
  lifecycleState().lastActivity = Date.now();
}

/** 持久流开/关各记一笔：会话 SSE、终端 SSE、文件 watch 流。 */
export function embedClientConnected(): void {
  lifecycleState().openStreams += 1;
}

export function embedClientDisconnected(): void {
  const s = lifecycleState();
  s.openStreams = Math.max(0, s.openStreams - 1);
}

/** 握手能力位。heartbeat 只在 watchdog 武装时声明——对独立实例是空话；
 *  shutdown 端点一直存在，attach 来的宿主靠它优雅停机。 */
export function embedCapabilities(): Record<string, true | Record<string, unknown>> {
  const caps: Record<string, true | Record<string, unknown>> = {
    "lifecycle.shutdown": true,
  };
  if (embedWatchdogArmed()) {
    caps["lifecycle.heartbeat"] = { timeoutSec: Math.round(watchdogTimeoutMs() / 1000) };
  }
  return caps;
}

/** 关机钩子由 instrumentation-node 在启动时注册（如关所有 SSE 流）；
 *  lifecycle 不反向 import 会话层，避免环。 */
export function onEmbedShutdown(fn: () => void): void {
  lifecycleState().shutdownHooks.add(fn);
}

/** 跑钩子后延时退——给在途的 HTTP 响应一点冲洗窗口；计时器加 ref，
 *  保证必然退出（服务器 socket 本来就撑着事件循环）。 */
export function requestEmbedShutdown(code = 0): void {
  const s = lifecycleState();
  if (s.shuttingDown) return;
  s.shuttingDown = true;
  for (const fn of [...s.shutdownHooks]) {
    try {
      fn();
    } catch {
      // 钩子尽力而为，不能挡住退出。
    }
  }
  setTimeout(() => process.exit(code), 500);
}

export function startEmbedWatchdog(): void {
  if (!embedWatchdogArmed()) return;
  const s = lifecycleState();
  if (s.timer) return;
  s.timer = setInterval(() => {
    const now = Date.now();
    const drift = now - s.lastTick;
    s.lastTick = now;
    if (drift > DRIFT_MS) {
      s.lastHeartbeat = now;
      s.lastActivity = now;
      return;
    }
    if (s.shuttingDown || s.openStreams > 0) return;
    const silence = now - Math.max(s.lastHeartbeat, s.lastActivity);
    if (silence <= watchdogTimeoutMs()) return;
    console.log(
      `[embed] watchdog: no heartbeat or client connection for ${Math.round(silence / 1000)}s — shutting down`,
    );
    requestEmbedShutdown(0);
  }, TICK_MS);
  s.timer.unref?.();
}
