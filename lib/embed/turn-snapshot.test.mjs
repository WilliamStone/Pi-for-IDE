import assert from "node:assert/strict";
import test from "node:test";
import { TurnSnapshotTracker } from "./turn-snapshot.ts";

test("pairWithLastUserEntry pairs the pending turnId to the last user entry", () => {
  const t = new TurnSnapshotTracker();
  // capture() 是 embed 限定的异步动作——直接注入 pending 以测配对逻辑。
  t["pendingTurnId"] = "turn-1";
  t.pairWithLastUserEntry(
    [{ role: "user" }, { role: "assistant" }, { role: "user" }],
    ["e1", "e2", "e3"],
  );
  assert.equal(t.turnIdForEntry("e3"), "turn-1");
  assert.equal(t.hasSnapshotFor("e3"), true);
  assert.equal(t.hasSnapshotFor("e1"), false);
});

test("turnIdForEntry degrades to the entryId itself when unpaired", () => {
  const t = new TurnSnapshotTracker();
  assert.equal(t.turnIdForEntry("eX"), "eX");
});

test("unpaired turn with no user entry keeps the pending id", () => {
  const t = new TurnSnapshotTracker();
  t["pendingTurnId"] = "turn-2";
  t.pairWithLastUserEntry([{ role: "assistant" }], ["e1"]);
  assert.equal(t["pendingTurnId"], "turn-2");
});
