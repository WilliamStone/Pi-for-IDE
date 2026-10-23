// 启动窗口记录（ide-spawn-<pid>.json）的读取过滤：进程存活 + 90s 内才作数。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";

// instance-coordination has no vscode dep — the hook just resolves
// extensionless .ts imports under strip-types.
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

const { listSpawnBootRecords } = await import("./instance-coordination.ts");
const readBootRecords = listSpawnBootRecords;

let dir;
let prevAgentDir;

function writeRecord(name, body) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
}

beforeEach(() => {
  prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "bootrec-"));
  process.env.PI_CODING_AGENT_DIR = base;
  dir = path.join(base, "pi-web-run");
  fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

const ALIVE_PID = process.pid; // 本进程必然存活——用它构造"活记录"。

test("fresh record with alive pid → returned", () => {
  writeRecord(`ide-spawn-${ALIVE_PID}.json`, {
    pid: ALIVE_PID,
    port: 3031,
    url: "http://127.0.0.1:3031",
    startedAt: new Date().toISOString(),
  });
  assert.deepEqual(readBootRecords(), [{ pid: ALIVE_PID, port: 3031 }]);
});

test("record with dead pid → skipped", () => {
  writeRecord("ide-spawn-99999999.json", {
    pid: 99999999, // 几乎不可能存活的 PID
    port: 3031,
    startedAt: new Date().toISOString(),
  });
  assert.deepEqual(readBootRecords(), []);
});

test("record older than 90s → skipped (crash leftover)", () => {
  writeRecord(`ide-spawn-${ALIVE_PID}.json`, {
    pid: ALIVE_PID,
    port: 3031,
    startedAt: new Date(Date.now() - 91_000).toISOString(),
  });
  assert.deepEqual(readBootRecords(), []);
});

test("non-boot filenames ignored (pi-web's own run-records coexist)", () => {
  writeRecord(`${ALIVE_PID}.json`, { pid: ALIVE_PID, port: 3030, url: "http://127.0.0.1:3030" });
  writeRecord("ide-server.lock.json", { pid: ALIVE_PID, port: 3030 });
  assert.deepEqual(readBootRecords(), []);
});

test("malformed json → skipped", () => {
  fs.writeFileSync(path.join(dir, "ide-spawn-1.json"), "{not json");
  assert.deepEqual(readBootRecords(), []);
});

test("record missing port/pid → skipped", () => {
  writeRecord(`ide-spawn-${ALIVE_PID}.json`, { pid: ALIVE_PID, startedAt: new Date().toISOString() });
  assert.deepEqual(readBootRecords(), []);
});
