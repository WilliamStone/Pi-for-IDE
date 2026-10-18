import assert from "node:assert/strict";
import test from "node:test";
import { revertTurnEntries } from "./turn-revert.ts";

const e = (id, parentId = null, type = "message") => ({ id, parentId, type });

test("removes the turn's entries and rewires children to the turn's parent", () => {
  const entries = [
    e("h", null, "session"),
    e("u1", "h"),
    e("a1", "u1"),
    e("r1", "a1"),
    e("u2", "r1"),
    e("a2", "u2"),
  ];
  const { ok, kept } = revertTurnEntries(entries, new Set(["u1", "a1", "r1"]));
  assert.equal(ok, true);
  assert.deepEqual(kept.map((x) => x.id), ["h", "u2", "a2"]);
  // 删轮之后的用户消息重连到被删轮的 parentId（session header）
  assert.equal(kept[1].parentId, "h");
});

test("refuses to delete the session header", () => {
  const entries = [e("h", null, "session"), e("u1", "h")];
  const r = revertTurnEntries(entries, new Set(["h", "u1"]));
  assert.equal(r.ok, false);
  assert.match(r.error, /header/);
});

test("refuses to delete everything", () => {
  const entries = [e("h", null, "session"), e("u1", "h")];
  const r = revertTurnEntries(entries, new Set(["u1"]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.kept.map((x) => x.id), ["h"]);
  const r2 = revertTurnEntries([e("u1")], new Set(["u1"]));
  assert.equal(r2.ok, false);
});

test("middle-turn removal reconnects the following turn", () => {
  // u1/a1 | u2/a2 | u3/a3，删中间轮 → u3 挂回 a1
  const entries = [
    e("u1"), e("a1", "u1"),
    e("u2", "a1"), e("a2", "u2"),
    e("u3", "a2"), e("a3", "u3"),
  ];
  const { ok, kept } = revertTurnEntries(entries, new Set(["u2", "a2"]));
  assert.equal(ok, true);
  assert.deepEqual(kept.map((x) => x.id), ["u1", "a1", "u3", "a3"]);
  assert.equal(kept[2].parentId, "a1");
});
