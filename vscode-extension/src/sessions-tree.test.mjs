import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "vscode") {
      return {
        url: new URL("./test-vscode-stub.mjs", import.meta.url).href,
        shortCircuit: true,
      };
    }
    if (
      specifier.startsWith("./") &&
      !specifier.endsWith(".ts") &&
      !specifier.endsWith(".mjs")
    ) {
      return { url: new URL(specifier + ".ts", context.parentURL).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { sessionIdOf } = await import("./session-id.ts");

test("sessionIdOf：剥 piIde.session. 前缀", () => {
  assert.equal(sessionIdOf({ id: "piIde.session.abc-123" }), "abc-123");
});

test("sessionIdOf：裸 id 原样返回（无前缀）", () => {
  assert.equal(sessionIdOf({ id: "abc-123" }), "abc-123");
});

test("sessionIdOf：无 id 抛出（?session=[object Object] 的防线）", () => {
  assert.throws(() => sessionIdOf({}), /missing id/);
  assert.throws(() => sessionIdOf({ id: "" }), /missing id/);
});
