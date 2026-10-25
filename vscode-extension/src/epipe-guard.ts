// 以 `node --require` 预载进 spawn 出的 pi-web 进程（见 piIdeServer.spawn）。
// 扩展宿主退出后 stdout/stderr 管道的读端消失——服务器下一次写日志会撞
// EPIPE 崩溃（Node 对无 error 监听者的流错误直接抛出）。装一个只吞
// 管道死亡类错误的监听者，让孤儿服务器活满自身生命周期（watchdog/显式
// stop），跨窗口重启/宿主崩溃后仍能被 attach 接管。非管道错误照旧抛出
// 走默认崩溃路径——不掩盖真故障。
import * as nodeModule from "node:module";

for (const s of [process.stdout, process.stderr]) {
  s?.on("error", (e: NodeJS.ErrnoException) => {
    if (e?.code === "EPIPE" || e?.code === "ERR_STREAM_DESTROYED") return;
    throw e;
  });
}

// 顺带白捡一层 V8 编译缓存（Node ≥22.1）：standalone 的 server bundle
// 几 MB 首次编译在慢盘/杀软下可达十几秒，缓存命中后跨 spawn 复用。
// 目录由宿主经 PI_IDE_COMPILE_CACHE 指定（globalStorage，持久）；旧
// Node 无此 API、目录不可写等失败一律不挡启动。
try {
  const enable = (nodeModule as { enableCompileCache?: (dir?: string) => unknown })
    .enableCompileCache;
  enable?.(process.env.PI_IDE_COMPILE_CACHE || undefined);
} catch {
  // 缓存不可用无碍启动。
}
