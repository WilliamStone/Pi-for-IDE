import assert from "node:assert/strict";
import test from "node:test";
import { extractFileChanges, normalizeChangePath } from "./file-changes.ts";

/** assistant 消息（toolCall blocks 用 pi 文件格式 id/name/arguments）。 */
function assistant(...toolCalls) {
  return {
    role: "assistant",
    content: toolCalls.map((tc) => ({ type: "toolCall", ...tc })),
  };
}
const tc = (id, name, args) => ({ id, name, arguments: args });
const tr = (toolCallId, extra = {}) => ({ role: "toolResult", toolCallId, isError: false, ...extra });
const user = () => ({ role: "user", content: [] });

test("normalizeChangePath unifies separators and strips trailing slash", () => {
  assert.equal(normalizeChangePath(String.raw`S:\dir\f.ts`), "S:/dir/f.ts");
  assert.equal(normalizeChangePath("S:/dir/"), "S:/dir");
  assert.equal(normalizeChangePath("/p/f"), "/p/f");
});

test("same-path consecutive edits aggregate their edits arrays", () => {
  const messages = [
    user(),
    assistant(
      tc("c1", "edit", { path: String.raw`S:\dir\f.ts`, edits: [{ oldText: "a", newText: "b" }] }),
      tc("c2", "edit", { path: "S:/dir/f.ts", edits: [{ oldText: "c", newText: "d" }] }),
    ),
    tr("c1", { details: { diff: "diff1" } }),
    tr("c2", { details: { diff: "diff2" } }),
  ];
  const changes = extractFileChanges(messages, "S:\\dir");
  assert.equal(changes.length, 1);
  const c = changes[0];
  assert.equal(c.kind, "edit");
  // 两笔 edits 按调用顺序聚合——回退需全反放
  assert.deepEqual(c.edits, [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }]);
  // 混合分隔符路径去重为同一文件
  assert.equal(c.path, "S:/dir/f.ts");
  assert.equal(c.relativePath, "f.ts");
});

test("write tool produces a created-typed change", () => {
  const messages = [
    user(),
    assistant(tc("w1", "write", { path: "/w/new.ts", content: "hello" })),
    tr("w1"),
  ];
  const [c] = extractFileChanges(messages, "/w");
  assert.equal(c.kind, "write");
  assert.equal(c.changeType, "created");
  assert.equal(c.newContent, "hello");
  assert.equal(c.relativePath, "new.ts");
});

test("error toolCalls are skipped; bash produces one untracked marker", () => {
  const messages = [
    user(),
    assistant(
      tc("e1", "edit", { path: "/w/f.ts", edits: [{ oldText: "a", newText: "b" }] }),
      tc("b1", "bash", { command: "echo x > g.ts" }),
      tc("b2", "bash", { command: "echo y > h.ts" }),
    ),
    tr("e1", { isError: true }),
    tr("b1"),
    tr("b2"),
  ];
  const changes = extractFileChanges(messages, "/w");
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "bash");
  assert.equal(changes[0].path, "");
});

test("relativePath computed against a Windows backslash cwd", () => {
  const messages = [
    user(),
    assistant(tc("c1", "edit", { path: String.raw`S:\dir\src\deep\f.ts`, edits: [{ oldText: "a", newText: "b" }] })),
    tr("c1"),
  ];
  const [c] = extractFileChanges(messages, String.raw`S:\dir`);
  assert.equal(c.relativePath, "src/deep/f.ts");
});
