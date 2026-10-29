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

const { createPanelVisibilityGate } = await import("./panel-visibility.ts");

const make = () => {
  const calls = [];
  const gate = createPanelVisibilityGate({
    suspend: () => calls.push("suspend"),
    resume: () => calls.push("resume"),
  });
  return { gate, calls };
};

test("hidden suspends; visible resumes only after a real suspend", () => {
  const { gate, calls } = make();
  gate.handle(true); // 首载即可见：不得触发多余重同步
  assert.deepEqual(calls, []);
  assert.equal(gate.suspended, false);

  gate.handle(false);
  assert.deepEqual(calls, ["suspend"]);
  assert.equal(gate.suspended, true);

  gate.handle(true);
  assert.deepEqual(calls, ["suspend", "resume"]);
  assert.equal(gate.suspended, false);
});

test("repeated hidden events suspend repeatedly but resume only once", () => {
  const { gate, calls } = make();
  gate.handle(false);
  gate.handle(false); // 幂等不消：重复隐藏重复关（连接已关也无害）
  gate.handle(true);
  gate.handle(true); // 第二个 true 不重复 resume
  assert.deepEqual(calls, ["suspend", "suspend", "resume"]);
});

test("a fresh suspend/resume cycle works after the first one", () => {
  const { gate, calls } = make();
  gate.handle(false);
  gate.handle(true);
  gate.handle(false);
  gate.handle(true);
  assert.deepEqual(calls, ["suspend", "resume", "suspend", "resume"]);
});
