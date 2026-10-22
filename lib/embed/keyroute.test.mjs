import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

// 仓库 .ts 不带扩展名的相对 import → 补 .ts 让 strip-types 直跑。
registerHooks({
  resolve(specifier, context, next) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !specifier.endsWith(".ts") &&
      !specifier.endsWith(".mjs")
    ) {
      return { url: new URL(specifier + ".ts", context.parentURL).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { shouldForward } = await import("./keyroute.ts");

const key = (k, mods = {}) => ({
  key: k,
  ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
  defaultPrevented: false,
  ...mods,
});

test("修饰键组合 → 转发（Ctrl/Alt/Meta 系）", () => {
  assert.equal(shouldForward(key("p", { ctrlKey: true })), true);
  assert.equal(shouldForward(key("p", { ctrlKey: true, shiftKey: true })), true);
  assert.equal(shouldForward(key("w", { ctrlKey: true })), true);
  assert.equal(shouldForward(key("i", { altKey: true })), true);
});

test("F1–F12 → 转发", () => {
  assert.equal(shouldForward(key("F1")), true);
  assert.equal(shouldForward(key("F12")), true);
  assert.equal(shouldForward(key("F5")), true);
});

test("裸字母/数字/方向键 → 留页面", () => {
  assert.equal(shouldForward(key("a")), false);
  assert.equal(shouldForward(key("1")), false);
  assert.equal(shouldForward(key("ArrowUp")), false);
  assert.equal(shouldForward(key("Enter")), false);
});

test("页面已消费（defaultPrevented）→ 不转发", () => {
  assert.equal(shouldForward(key("p", { ctrlKey: true, defaultPrevented: true })), false);
});

test("IME 组词中 → 不转发；纯修饰键按下 → 不转发", () => {
  assert.equal(shouldForward(key("p", { ctrlKey: true, isComposing: true })), false);
  assert.equal(shouldForward(key("Control", { ctrlKey: true })), false);
  assert.equal(shouldForward(key("Shift", { shiftKey: true })), false);
});
