// Windows-WMI spawn 路径的端到端验证：spawnViaWmi 生成的 .cmd/.ps1 经
// Win32_Process.Create 在扩展宿主 Job 之外拉起服务器，log 尾读识别就绪
// URL，kill 检测等价 child.on('exit')。真实过一遍 WMI——只在 win32 跑。
import assert from "node:assert/strict";
import test from "node:test";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "vscode") {
      return {
        url: new URL("./test-vscode-stub.mjs", import.meta.url).href,
        shortCircuit: true,
      };
    }
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.(mjs|cjs|js|ts|json)$/.test(specifier)
    ) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

const { PiIdeServer } = await import("./piIdeServer.ts");

const isWin = process.platform === "win32";
const TEST_PORT = 3997;

/** 不透传 vscode.ExtensionContext——只造 spawnViaWmi 用到的字段面。 */
function makeServer(storageDir, logLines) {
  const server = Object.create(PiIdeServer.prototype);
  server.context = {
    extensionPath: path.resolve(import.meta.dirname, ".."),
    globalStorageUri: { fsPath: storageDir },
  };
  server.channel = { appendLine: (l) => logLines.push(l) };
  server.disposed = false;
  server.resolvedOrigin = undefined;
  server.spawnWatchTimer = undefined;
  server.ownedPid = undefined;
  return server;
}

test("spawnViaWmi: ready via log tail, exit via pid watch", { skip: !isWin, timeout: 45_000 }, async () => {
  const base = mkdtempSync(path.join(tmpdir(), "wmi-spawn-"));
  const logs = [];
  // fixture：打一个就绪 URL 行 + 持续运行——模拟 Next "Local: ..." 输出。
  const fixture = path.join(base, "fixture-server.js");
  writeFileSync(
    fixture,
    `require("http").createServer((q,s)=>s.end("ok")).listen(${TEST_PORT},"127.0.0.1",` +
      `()=>console.log("- Local: http://127.0.0.1:${TEST_PORT}"));setInterval(()=>{},60000);`,
  );
  const server = makeServer(base, logs);
  try {
    const origin = await server.spawnViaWmi(
      process.execPath,
      [fixture],
      { PATH: process.env.PATH, PORT: String(TEST_PORT) },
      TEST_PORT,
      20_000,
    );
    assert.equal(origin, `http://127.0.0.1:${TEST_PORT}`, "ready line should resolve origin");
    assert.equal(typeof server.ownedPid, "number", "WMI cmd pid recorded as ownedPid");

    // log 文件真落盘且含就绪行；channel 也收到同一行。
    const logDir = path.join(base, "logs");
    const logFile = readdirSync(logDir).find((f) => f.startsWith("server-"));
    assert.ok(logFile, "server-*.log exists under globalStorage/logs");
    assert.match(readFileSync(path.join(logDir, logFile), "utf8"), /Local: http:\/\/127\.0\.0\.1:3997/);

    const res = await fetch(origin);
    assert.equal(await res.text(), "ok", "spawned server actually serves");

    // 存活巡检：taskkill /T 整棵杀掉 cmd+node 后 ~1s 内应置 disposed。
    execSync(`taskkill /PID ${server.ownedPid} /T /F`, { windowsHide: true });
    const deadline = Date.now() + 5_000;
    while (!server.disposed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(server.disposed, true, "pid watch should mark disposed after tree kill");
  } finally {
    server.clearSpawnWatch();
    if (server.ownedPid !== undefined && !server.disposed) {
      try { execSync(`taskkill /PID ${server.ownedPid} /T /F`, { windowsHide: true }); } catch { /* 已死 */ }
    }
    rmSync(base, { recursive: true, force: true });
  }
});
