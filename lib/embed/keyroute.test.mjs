import assert from "node:assert/strict";
import test from "node:test";
import { shouldForward } from "./keyroute.ts";

const ev = (key, mods = {}, extra = {}) => ({
  key,
  ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
  defaultPrevented: false, isComposing: false,
  ...mods, ...extra,
});

test("shouldForward: modifier chords pass, consumed/IME/plain keys stay", () => {
  // 组合键转发
  assert.equal(shouldForward(ev("j", { ctrlKey: true })), true);
  assert.equal(shouldForward(ev("P", { ctrlKey: true, shiftKey: true })), true);
  assert.equal(shouldForward(ev("F5")), true);
  assert.equal(shouldForward(ev("F12")), true);
  // 页面已消费 → 不转发（防双重触发）
  assert.equal(shouldForward(ev("k", { ctrlKey: true }, { defaultPrevented: true })), false);
  // IME 组词中 → 不转发
  assert.equal(shouldForward(ev("j", { ctrlKey: true }, { isComposing: true })), false);
  // 纯修饰键 → 不转发
  assert.equal(shouldForward(ev("Control", { ctrlKey: true })), false);
  assert.equal(shouldForward(ev("Shift", { shiftKey: true })), false);
  // 裸键（页面自身需要）→ 不转发
  assert.equal(shouldForward(ev("j")), false);
  assert.equal(shouldForward(ev("1")), false);
  assert.equal(shouldForward(ev("ArrowDown")), false);
  // shift+字母单独按 → 不转发（正常输入大写）
  assert.equal(shouldForward(ev("J", { shiftKey: true })), false);
});
