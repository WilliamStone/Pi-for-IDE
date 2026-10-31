// attach 来的服务器"死亡"两条路径的回归验证：
//  1. stop() 的 shutdown-ask 要等服务器真释放端口——204≠死透（服务端有
//     ~500ms 冲洗窗仍在应答），不等就返回会让紧随的 ensureStarted 把将死
//     实例 attach 回来，接回来它才死，留下永远 running 的死引用。
//  2. 心跳失败的确认探测（noteHeartbeatMiss）区分"一次没答"与"真死了"：
//     attach 实例没有 pid 巡检，真死必须 disposed 释放引用，下一个真实
//     ensureStarted 才能走 attach→spawn 换新实例；owned 实例归 spawnWatch
//     管（它能区分"进程死了"与"活着但 HTTP 挂"），这里不抢判定。
// 平台无关：fixture 是 cp.spawn 的真 node 进程，/api/embed/shutdown 延迟
// 400ms 退出，复刻生产优雅停机的冲洗窗口。
import assert from "node:assert/strict";
import test from "node:test";
import * as cp from "node:child_process";
import * as net from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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

const TEST_PORT = 3996;
const ORIGIN = `http://127.0.0.1:${TEST_PORT}`;
// 生产冲洗窗 ~500ms（lifecycle.requestEmbedShutdown 的 setTimeout）；测试
// 用 400ms——足够拉开"立即返回"与"等到真死"的区别，又不拖慢套件。
const FLUSH_MS = 400;

/** attach 形态的最小实例面：无 child/ownedPid，resolvedOrigin 就位。 */
function makeAttachedServer(logs) {
  const server = Object.create(PiIdeServer.prototype);
  server.context = {};
  server.channel = { appendLine: (l) => logs.push(l) };
  server.disposed = false;
  server.resolvedOrigin = ORIGIN;
  server.boundOrigin = ORIGIN;
  server.embedCapabilities = { "lifecycle.shutdown": true, "lifecycle.heartbeat": {} };
  server.ownedPid = undefined;
  server.child = undefined;
  server.spawnWatchTimer = undefined;
  server.heartbeatTimer = undefined;
  server.goneProbing = false;
  return server;
}

const portBound = (port) =>
  new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    sock.setTimeout(500);
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });

async function waitFor(cond, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

/** spawn fixture 服务器并等它开始监听；返回 ChildProcess。 */
async function spawnFixture(dir) {
  const file = path.join(dir, "fixture-server.cjs");
  writeFileSync(
    file,
    `require("http").createServer((q,s)=>{` +
      `if(q.method==="GET"&&q.url==="/api/embed"){s.writeHead(200,{"content-type":"application/json"});s.end('{"embed":{}}');return;}` +
      `if(q.method==="POST"&&q.url==="/api/embed/shutdown"){s.writeHead(204);s.end();setTimeout(()=>process.exit(0),${FLUSH_MS});return;}` +
      `s.writeHead(404);s.end();}).listen(${TEST_PORT},"127.0.0.1");`,
  );
  const child = cp.spawn(process.execPath, [file], { stdio: "ignore", windowsHide: true });
  const up = await waitFor(() => portBound(TEST_PORT));
  assert.ok(up, "fixture server failed to bind");
  return child;
}

test("stop(): shutdown-ask waits for the port to actually free", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "server-death-"));
  const logs = [];
  const child = await spawnFixture(dir);
  const server = makeAttachedServer(logs);
  globalThis.__piIdeServer = server;
  const t0 = Date.now();
  try {
    await server.stop();
    const elapsed = Date.now() - t0;
    assert.ok(
      elapsed >= FLUSH_MS - 100,
      `stop() returned after ${elapsed}ms — it did not wait for the dying server's flush window`,
    );
    assert.equal(await portBound(TEST_PORT), false, "port must be free when stop() returns");
    assert.equal(globalThis.__piIdeServer, undefined, "global singleton released");
    assert.ok(logs.some((l) => l.includes("asked the shared server")), "shutdown ask logged");
  } finally {
    try { child.kill("SIGKILL"); } catch { /* 已死 */ }
    delete globalThis.__piIdeServer;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("noteHeartbeatMiss: dead attached instance is released; live probe and owned instances stay", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "server-death-"));
  const logs = [];
  const child = await spawnFixture(dir);
  const server = makeAttachedServer(logs);
  globalThis.__piIdeServer = server;
  try {
    // 服务器活着：一次心跳 miss 只是抖动，不放引用。
    await server.noteHeartbeatMiss(ORIGIN);
    assert.equal(server.disposed, false, "alive server must survive a transient heartbeat miss");

    // 服务器真死：确认探测也探不通 → 判死、放引用、清全局。
    child.kill("SIGKILL");
    assert.ok(await waitFor(async () => !(await portBound(TEST_PORT))), "fixture port should free after kill");
    await server.noteHeartbeatMiss(ORIGIN);
    assert.equal(server.disposed, true, "dead attached instance must be released");
    assert.equal(globalThis.__piIdeServer, undefined, "released instance drops the global singleton");
    assert.ok(
      logs.some((l) => l.includes("is gone — released the attached instance")),
      "release logged",
    );

    // owned 实例（ownedPid 有值）：同条件不判死——死亡判定归 pid 巡检。
    const owned = makeAttachedServer(logs);
    owned.ownedPid = 999_999;
    await owned.noteHeartbeatMiss(ORIGIN);
    assert.equal(owned.disposed, false, "owned instance defers death detection to the pid watch");
  } finally {
    try { child.kill("SIGKILL"); } catch { /* 已死 */ }
    delete globalThis.__piIdeServer;
    rmSync(dir, { recursive: true, force: true });
  }
});
