// Process-level regression coverage for the cross-window protocol — the bug
// class that unit tests can't see: two REAL node processes racing on real
// files (locks, markers, watchers). Each scenario maps to a production bug:
//
//   lock-race        → duplicate spawns when the lock doesn't serialize
//   stale sweep      → a dead-owner lock must not block the next acquirer
//   marker converge  → the observed kill-loop: newer marker must release (not
//                      stop) an attached instance; a stale marker must not evict
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const { writeInstanceMarker } = await import("./instance-coordination.ts");

const DRIVER = fileURLToPath(new URL("./coordination-driver.mjs", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkRunDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `coord-${prefix}-`));
}

/** Spawn the driver; resolve when `waitFor` appears on stdout (or on exit). */
function spawnDriver(args, waitFor) {
  const proc = spawn(process.execPath, ["--experimental-strip-types", DRIVER, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = [];
  let readyResolve;
  const ready = waitFor
    ? new Promise((res, rej) => {
        readyResolve = res;
        proc.once("exit", (code) => rej(new Error(`driver exited ${code} before ${waitFor}`)));
      })
    : Promise.resolve();
  proc.stdout.setEncoding("utf8").on("data", (chunk) => {
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      lines.push(line.trim());
      if (waitFor && line.includes(waitFor)) readyResolve();
    }
  });
  proc.stderr.setEncoding("utf8").on("data", (c) => lines.push(`STDERR ${c}`));
  const exited = new Promise((res) => proc.once("exit", res));
  return { proc, lines, ready, exited, kill: () => proc.kill() };
}

test("file lock serializes two real processes (no interleaved critical sections)", async () => {
  const dir = mkRunDir("lock");
  const a = spawnDriver(["lock-race", dir, "A"]);
  const b = spawnDriver(["lock-race", dir, "B"]);
  await Promise.all([a.exited, b.exited]);
  const log = fs.readFileSync(path.join(dir, "race.log"), "utf8");
  // ENTER/EXIT pairs must be strictly paired — an ENTER-ENTER means the lock failed.
  assert.match(log, /ENTER (\w)\nEXIT \1\nENTER (\w)\nEXIT \2\n/);
});

test("dead-owner lock is swept and the next process proceeds", async () => {
  const dir = mkRunDir("stale");
  // Plant a lock owned by a PID that can't exist.
  const lockDir = path.join(dir, "ide-server.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, "owner.json"),
    JSON.stringify({ pid: 99999999, op: "crashed-run", at: Date.now() }),
  );
  const a = spawnDriver(["lock-race", dir, "S"]);
  await a.exited;
  const log = fs.readFileSync(path.join(dir, "race.log"), "utf8");
  assert.match(log, /ENTER S\nEXIT S\n/);
});

test("marker protocol converges: newest wins, attached releases (never stops), stale can't evict", async () => {
  const dir = mkRunDir("marker");
  // Window A holds attached server boot=100; window B holds attached boot=200.
  const a = spawnDriver(["watch", dir, "A", "100", "attached"], "[A] READY");
  const b = spawnDriver(["watch", dir, "B", "200", "attached"], "[B] READY");
  try {
    await Promise.all([a.ready, b.ready]);
    await sleep(200);

    // B's spawn "wins" the race and announces boot=200.
    writeInstanceMarker(dir, { boot: "200", origin: "http://127.0.0.1:3031" });
    await sleep(1200); // 300ms debounce + invalidate + margin

    // A must release its reference — and must NEVER call stop() (that POSTs
    // /api/embed/shutdown and murders the shared server B is attached to).
    const aOut = a.lines.join("\n");
    assert.match(aOut, /\[A\] marker=200 invalidate=true/);
    assert.match(aOut, /\[A\] ACTION release/);
    assert.doesNotMatch(aOut, /ACTION stop/);
    // B sees its own boot — nothing to do.
    assert.match(b.lines.join("\n"), /\[B\] marker=200 invalidate=false/);

    // Now a STALE marker lands late (a slower window's older spawn writing
    // late). Under the old ≠-comparison this evicted the live instance —
    // the ping-pong kill loop. B's boot=200 is newer; it must not budge.
    writeInstanceMarker(dir, { boot: "150", origin: "http://127.0.0.1:3030" });
    await sleep(1200);
    assert.doesNotMatch(b.lines.join("\n"), /invalidate=true/);
    assert.doesNotMatch(b.lines.join("\n"), /ACTION/);
    // A already released; a second invalidate must not fire.
    assert.equal(a.lines.filter((l) => l.includes("invalidate=true")).length, 1);
  } finally {
    a.kill();
    b.kill();
  }
});
