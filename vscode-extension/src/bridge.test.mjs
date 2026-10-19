import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";

// bridge.ts imports "vscode" — redirect the specifier to our node-fs stub.
// registerHooks must be installed before the dynamic import below resolves it.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "vscode") {
      return {
        url: new URL("./test-vscode-stub.mjs", import.meta.url).href,
        shortCircuit: true,
      };
    }
    // 源码里的相对 import 不带扩展名（bundler/tsc 约定）——node 直跑要补 .ts
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.(mjs|cjs|js|ts|json)$/.test(specifier)
    ) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

const { Bridge } = await import("./bridge.ts");
const { calls } = await import("./test-vscode-stub.mjs");

function git(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** 真 git 仓库临时目录：一次初始提交 + 一个未提交改动 + 一个未追踪文件。 */
function makeRepo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-bridge-"));
  t.after(() => undefined); // tmpdirs are per-run; OS cleans up
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "clean.txt"), "clean-committed\n");
  writeFileSync(path.join(dir, "dirty.txt"), "dirty-committed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  writeFileSync(path.join(dir, "dirty.txt"), "dirty-edited\n");
  writeFileSync(path.join(dir, "untracked.txt"), "untracked-content\n");
  return dir;
}

test("captureSnapshot stores dirty + untracked files keyed by case-insensitive path", async (t) => {
  const repo = makeRepo(t);
  const bridge = new Bridge(() => {});
  const res = await bridge.handle({ kind: "captureSnapshot", turnId: "t1", cwd: repo });
  assert.equal(res.success, true);

  // 相对路径查询命中快照
  let before = await bridge.handle({ kind: "getBeforeContent", turnId: "t1", filePath: "dirty.txt", cwd: repo });
  assert.equal(before.content, "dirty-edited\n");
  // 未追踪文件也在快照里
  before = await bridge.handle({ kind: "getBeforeContent", turnId: "t1", filePath: "untracked.txt", cwd: repo });
  assert.equal(before.content, "untracked-content\n");
  // HEAD 兜底：clean.txt 不在快照但 HEAD 有
  before = await bridge.handle({ kind: "getBeforeContent", turnId: "t1", filePath: "clean.txt", cwd: repo });
  assert.equal(before.content, "clean-committed\n");
  // HEAD 与快照都没有 → null
  before = await bridge.handle({ kind: "getBeforeContent", turnId: "t1", filePath: "missing.txt", cwd: repo });
  assert.equal(before.content, null);

  // 大小写混洗的绝对路径（win32 上命中同一键；POSIX 上视为不同文件）
  const abs = path.join(repo, "dirty.txt");
  const swapped = process.platform === "win32" ? abs.replace(/^([a-z])/i, (c) => c.toUpperCase()) : abs;
  before = await bridge.handle({ kind: "getBeforeContent", turnId: "t1", filePath: swapped, cwd: repo });
  assert.equal(before.content, "dirty-edited\n");
});

test("revertFiles deletes a created file and restores snapshot content", async (t) => {
  const repo = makeRepo(t);
  const bridge = new Bridge(() => {});
  await bridge.handle({ kind: "captureSnapshot", turnId: "t1", cwd: repo });

  // 本轮新建 + 本轮又改了 dirty.txt
  writeFileSync(path.join(repo, "created.txt"), "created-by-turn\n");
  writeFileSync(path.join(repo, "dirty.txt"), "dirty-turn-change\n");

  const res = await bridge.handle({
    kind: "revertFiles",
    turnId: "t1",
    files: ["dirty.txt", "created.txt"],
    created: ["created.txt"],
    cwd: repo,
  });
  assert.equal(res.success, true, res.message);
  assert.equal(readFileSync(path.join(repo, "dirty.txt"), "utf8"), "dirty-edited\n");
  assert.equal(existsSync(path.join(repo, "created.txt")), false);
});

test("revertFiles refuses paths outside the session cwd", async (t) => {
  const repo = makeRepo(t);
  const outside = mkdtempSync(path.join(tmpdir(), "pi-bridge-out-"));
  writeFileSync(path.join(outside, "victim.txt"), "keep\n");
  const bridge = new Bridge(() => {});
  await bridge.handle({ kind: "captureSnapshot", turnId: "t1", cwd: repo });

  const res = await bridge.handle({
    kind: "revertFiles",
    turnId: "t1",
    files: [path.join(outside, "victim.txt")],
    cwd: repo,
  });
  assert.equal(res.success, false);
  assert.match(res.message, /outside session cwd/);
  assert.equal(readFileSync(path.join(outside, "victim.txt"), "utf8"), "keep\n");
});

test("reconstructBefore reverse-applies edits against the current file", async (t) => {
  const repo = makeRepo(t);
  const bridge = new Bridge(() => {});
  writeFileSync(path.join(repo, "live.txt"), "alpha\nBETA\nomega\n");
  const res = await bridge.handle({
    kind: "reconstructBefore",
    filePath: "live.txt",
    cwd: repo,
    edits: [{ oldText: "beta", newText: "BETA" }],
  });
  assert.equal(res.content, "alpha\nbeta\nomega\n");

  // newText 已漂离 → 拒绝而非造假的 before
  const drifted = await bridge.handle({
    kind: "reconstructBefore",
    filePath: "live.txt",
    cwd: repo,
    edits: [{ oldText: "x", newText: "NOT-PRESENT" }],
  });
  assert.equal(drifted.content, null);
});

test("openText requests a host in-memory document", async (t) => {
  const bridge = new Bridge(() => {});
  await bridge.handle({ kind: "openText", content: "@@ -1 +1 @@\n-a\n+b", language: "diff" });
  assert.equal(calls.showTextDocument.length, 1);
  assert.equal(calls.showTextDocument[0].doc.language, "diff");
});

test("showDiff writes both temp sides and invokes vscode.diff", async (t) => {
  const bridge = new Bridge(() => {});
  await bridge.handle({ kind: "showDiff", filePath: "f.ts", before: "old\n", after: "new\n" });
  const diff = calls.executeCommand.find((c) => c.cmd === "vscode.diff");
  assert.ok(diff, "vscode.diff command invoked");
  assert.ok(existsSync(diff.args[0].fsPath) && existsSync(diff.args[1].fsPath));
});
