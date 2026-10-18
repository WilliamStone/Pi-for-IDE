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

export function recordEmbedHeartbeat(): void {
  lifecycleState().lastHeartbeat = Date.now();
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
