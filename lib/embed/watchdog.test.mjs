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

const { classifyView } = await import("./watchdog.ts");

const probe = (over = {}) => ({
  rows: 0,
  loadingGate: false,
  errorGate: false,
  composer: true,
  scrollerHidden: false,
  ...over,
});

test("有行且未隐藏 → content", () => {
  assert.equal(classifyView(probe({ rows: 11 })), "content");
});

test("有行但滚动容器 visibility:hidden → hidden-rows", () => {
  assert.equal(classifyView(probe({ rows: 11, scrollerHidden: true })), "hidden-rows");
});

test("error 门优先于一切（含 loading）", () => {
  assert.equal(classifyView(probe({ errorGate: true, loadingGate: true })), "error");
});

test("0 行 + loading 门 → loading（慢加载，非 wedge）", () => {
  assert.equal(classifyView(probe({ loadingGate: true })), "loading");
});

test("门已过 + composer 在 + 0 行 → empty-suspect", () => {
  assert.equal(classifyView(probe()), "empty-suspect");
});

test("0 行 + 无 composer → boot（未挂载到聊天视图）", () => {
  assert.equal(classifyView(probe({ composer: false })), "boot");
});
