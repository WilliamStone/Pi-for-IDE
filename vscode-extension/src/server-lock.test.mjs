import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { withServerLock } from "./server-lock.ts";

function fixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lock-test-"));
  const log = [];
  return {
    dir,
    channel: { appendLine: (m) => log.push(m) },
    log,
    deps: {
      dir,
      isAlive: () => true,
      now: Date.now,
      acquireTimeoutMs: 500,
      staleMs: 60_000,
      sleep: () => Promise.resolve(), // 立即重试——测试不等真时钟
      ...overrides,
    },
  };
}

const lockDirOf = (dir) => path.join(dir, "ide-server.lock");

test("withServerLock：临界区执行后释放锁目录", async () => {
  const { dir, deps, channel } = fixture();
  const result = await withServerLock("op", async () => "done", deps, channel);
  assert.equal(result, "done");
  assert.equal(fs.existsSync(lockDirOf(dir)), false);
});

test("withServerLock：fn 抛错也释放锁", async () => {
  const { dir, deps, channel } = fixture();
  await assert.rejects(() =>
    withServerLock("op", async () => {
      throw new Error("boom");
    }, deps, channel),
  );
  assert.equal(fs.existsSync(lockDirOf(dir)), false);
});

test("withServerLock：持有者已死的陈旧锁被清扫后获取", async () => {
  const { dir, deps, channel, log } = fixture();
  // 预置一个"死进程"持有的锁
  fs.mkdirSync(lockDirOf(dir), { recursive: true });
  fs.writeFileSync(
    path.join(lockDirOf(dir), "owner.json"),
    JSON.stringify({ pid: 424242, op: "dead-op", at: Date.now() }),
  );
  const result = await withServerLock(
    "op",
    async () => "ran",
    { ...deps, isAlive: (pid) => pid === process.pid },
    channel,
  );
  assert.equal(result, "ran");
  assert.ok(log.some((l) => l.includes("stale")));
});

test("withServerLock：活锁等到超时后降级执行（不硬卡）", async () => {
  let now = 0;
  const { dir, deps, channel, log } = fixture();
  deps.now = () => now;
  deps.acquireTimeoutMs = 500;
  deps.sleep = async () => {
    now += 400; // 假时钟随等待推进——否则轮询死循环
  };
  // 占住一把"活着且年轻"的锁
  fs.mkdirSync(lockDirOf(dir), { recursive: true });
  fs.writeFileSync(
    path.join(lockDirOf(dir), "owner.json"),
    JSON.stringify({ pid: 31337, op: "other-window", at: 0 }),
  );
  const ran = await withServerLock(
    "op",
    async () => {
      now += 10_000;
      return "ran-unlocked";
    },
    deps,
    channel,
  );
  assert.equal(ran, "ran-unlocked"); // 超时降级：依然执行
  assert.ok(log.some((l) => l.includes("timed out")));
  // 降级执行不释放别人的锁
  assert.equal(fs.existsSync(lockDirOf(dir)), true);
});

test("withServerLock：同进程重入不死锁", async () => {
  const { dir, deps, channel } = fixture();
  const result = await withServerLock(
    "outer",
    async () => withServerLock("inner", async () => "nested", deps, channel),
    deps,
    channel,
  );
  assert.equal(result, "nested");
  assert.equal(fs.existsSync(lockDirOf(dir)), false);
});

test("withServerLock：owner.json 记录持有者身份", async () => {
  const { dir, deps, channel } = fixture();
  let captured;
  await withServerLock(
    "my-op",
    async () => {
      captured = JSON.parse(fs.readFileSync(path.join(lockDirOf(dir), "owner.json"), "utf8"));
    },
    deps,
    channel,
  );
  assert.equal(captured.pid, process.pid);
  assert.equal(captured.op, "my-op");
});
