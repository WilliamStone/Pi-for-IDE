// 以 `node --require` 预载进 spawn 出的 pi-web 进程（见 piIdeServer.spawn）。
// 扩展宿主退出后 stdout/stderr 管道的读端消失——服务器下一次写日志会撞
// EPIPE 崩溃（Node 对无 error 监听者的流错误直接抛出）。装一个只吞
// 管道死亡类错误的监听者，让孤儿服务器活满自身生命周期（watchdog/显式
// stop），跨窗口重启/宿主崩溃后仍能被 attach 接管。非管道错误照旧抛出
// 走默认崩溃路径——不掩盖真故障。
for (const s of [process.stdout, process.stderr]) {
  s?.on("error", (e: NodeJS.ErrnoException) => {
    if (e?.code === "EPIPE" || e?.code === "ERR_STREAM_DESTROYED") return;
    throw e;
  });
}
