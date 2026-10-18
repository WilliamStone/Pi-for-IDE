import assert from "node:assert/strict";
import test from "node:test";
import { applyEditsReversed } from "./revert.ts";

test("reverses a single edit", () => {
  const r = applyEditsReversed("hello new world", [{ oldText: "old", newText: "new" }]);
  assert.deepEqual(r, { ok: true, content: "hello old world" });
});

test("reverses multiple edits in reverse order", () => {
  // 前向：first→X，second→Y → 反序换回
  const r = applyEditsReversed("X and Y", [
    { oldText: "first", newText: "X" },
    { oldText: "second", newText: "Y" },
  ]);
  assert.deepEqual(r, { ok: true, content: "first and second" });
});

test("missing newText → refused (external modification)", () => {
  const r = applyEditsReversed("no match here", [{ oldText: "a", newText: "zzz" }]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not found/);
});

test("ambiguous newText (multiple occurrences) → refused, no partial write", () => {
  // newText 出现两次——替换第一处会改错位置（真实场景：同文件多段同文本）。
  const r = applyEditsReversed("foo bar foo", [{ oldText: "x", newText: "foo" }]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /occurs 2 times/);
});

test("$-metacharacters in oldText are preserved literally", () => {
  // 函数式 replacer：$&（匹配子串）、$`（前缀）、$1（分组）不得被解释。
  const oldText = "const re = /$&$`$'/; let $1 = 2;";
  const r = applyEditsReversed("X X X", [{ oldText, newText: "X X X" }].slice(0, 0).concat([
    { oldText, newText: "X X X" },
  ]));
  assert.deepEqual(r, { ok: true, content: oldText });
});

test("empty edits list is a no-op success", () => {
  assert.deepEqual(applyEditsReversed("unchanged", []), { ok: true, content: "unchanged" });
});
