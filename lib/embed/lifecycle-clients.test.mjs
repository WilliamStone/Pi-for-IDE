// shutdown 许可判据（服务端收权）：存在"可证明的另一个使用方"才拒绝——
// 旧版宿主（≠判据 + attach 也 stop 的谋杀链）对共享服务器的 POST 在
// 新旧混跑时被拒；老单窗的显式 Stop 语义保留（只有匿名桶时放行）。
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.(mjs|cjs|js|ts|json)$/.test(specifier)
    ) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

const { recordEmbedHeartbeat, activeEmbedClients, embedShutdownAllowed } = await import("./lifecycle.ts");

const STATE_KEY = Symbol.for("pi-web.embedLifecycle");

beforeEach(() => {
  // 生命周期态挂在 globalThis 的 Symbol.for 键上——测试间清掉重来。
  delete globalThis[STATE_KEY];
});

test("anonymous beats only → anonymous shutdown allowed (old single-window stop preserved)", () => {
  recordEmbedHeartbeat(); // 旧版宿主不带 client → 匿名桶
  assert.equal(embedShutdownAllowed(undefined).allowed, true);
});

test("identified client beating → anonymous shutdown refused (old window can't murder a new window's server)", () => {
  recordEmbedHeartbeat("win-b"); // 新窗在跳
  const r = embedShutdownAllowed(undefined); // 旧窗匿名请求
  assert.equal(r.allowed, false);
  assert.equal(r.others, 1);
});

test("two identified clients → each sees the other as 'in use'", () => {
  recordEmbedHeartbeat("a");
  recordEmbedHeartbeat("b");
  assert.equal(embedShutdownAllowed("a").allowed, false);
  assert.equal(embedShutdownAllowed("a").others, 1);
  assert.equal(embedShutdownAllowed("b").allowed, false);
});

test("sole identified client → its shutdown allowed", () => {
  recordEmbedHeartbeat("a");
  assert.equal(embedShutdownAllowed("a").allowed, true);
});

test("anonymous bucket counts as 'other' for an identified requester (old window is a real user)", () => {
  recordEmbedHeartbeat();      // 旧窗在跳（匿名桶）
  recordEmbedHeartbeat("new"); // 新窗在跳
  const r = embedShutdownAllowed("new");
  assert.equal(r.allowed, false); // 新窗也要确认/force
  assert.equal(r.others, 1);
});

test("no clients at all → shutdown allowed", () => {
  assert.equal(embedShutdownAllowed(undefined).allowed, true);
  assert.equal(embedShutdownAllowed("x").allowed, true);
});

test("activeEmbedClients reports live ids", () => {
  recordEmbedHeartbeat();
  recordEmbedHeartbeat("a");
  assert.deepEqual(new Set(activeEmbedClients()), new Set(["", "a"]));
});
