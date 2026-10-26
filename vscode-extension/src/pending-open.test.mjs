import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";

// 源码里的相对 import 不带扩展名（bundler/tsc 约定）——node 直跑要补 .ts。
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

const { writePendingOpen, watchPendingOpens, pendingOpensDir } = await import("./pending-open.ts");

function setup() {
  const runDir = mkdtempSync(path.join(tmpdir(), "pi-po-"));
  return { runDir, dir: pendingOpensDir(runDir) };
}

test("pending-open: matching record is consumed and removed on first scan", () => {
  const { runDir, dir } = setup();
  writePendingOpen("S:\\proj\\a", "sess-1", runDir);
  writePendingOpen("S:\\proj\\other", "sess-2", runDir);
  const consumed = [];
  const w = watchPendingOpens({
    runDir,
    workspaceRoots: () => ["s:\\proj\\a"], // win32 大小写归一也应命中
    consume: (id) => consumed.push(id),
  });
  try {
    assert.deepEqual(consumed, ["sess-1"]);
    // 异目录记录留下、命中记录已删——只剩 1 个文件。
    assert.equal(readdirSync(dir).filter((n) => n.endsWith(".json")).length, 1);
  } finally {
    w?.dispose();
  }
});

test("pending-open: expired records are swept without consuming", () => {
  const { runDir, dir } = setup();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "old.json"),
    JSON.stringify({ sessionId: "sess-old", dir: "S:\\proj\\a", at: Date.now() - 10 * 60_000 }),
  );
  const consumed = [];
  const w = watchPendingOpens({
    runDir,
    workspaceRoots: () => ["S:\\proj\\a"],
    consume: (id) => consumed.push(id),
  });
  try {
    assert.deepEqual(consumed, []);
    assert.equal(readdirSync(dir).filter((n) => n.endsWith(".json")).length, 0);
  } finally {
    w?.dispose();
  }
});

test("pending-open: record written later is consumed via fs.watch", async () => {
  const { runDir } = setup();
  const consumed = [];
  const w = watchPendingOpens({
    runDir,
    workspaceRoots: () => ["S:\\proj\\a"],
    consume: (id) => consumed.push(id),
  });
  try {
    writePendingOpen("S:\\proj\\a", "sess-late", runDir);
    const deadline = Date.now() + 3000;
    while (!consumed.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.deepEqual(consumed, ["sess-late"]);
  } finally {
    w?.dispose();
  }
});
