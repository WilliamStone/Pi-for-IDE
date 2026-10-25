// epipe-guard 契约钉扎：spawn 必须以 --require 注入守卫；守卫只吞
// 管道死亡类错误（EPIPE/流已销毁），其余错误照旧抛出不掩盖。
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

const src = (f) =>
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), f),
    "utf8",
  );

test("spawn 对 node 入口注入 --require epipe-guard", () => {
  const s = src("piIdeServer.ts");
  assert.match(s, /--require/);
  assert.match(s, /epipe-guard\.js/);
  // 旗标必须在脚本/包入口之前拼接进 args。
  assert.match(s, /args = \[\.\.\.nodeArgs, \.\.\.args\]/);
});

test("守卫只吞管道死亡错误，其余照常抛出", () => {
  const s = src("epipe-guard.ts");
  assert.match(s, /process\.stdout/);
  assert.match(s, /process\.stderr/);
  assert.match(s, /EPIPE/);
  assert.match(s, /throw e/);
});
