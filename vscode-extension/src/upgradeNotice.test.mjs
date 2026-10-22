import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
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

const { markUpgradeSurfaced, wasUpgradeSurfaced, upgradeActionSig, localUpgradeSig } =
  await import("./upgradeNotice.ts");

test("upgradeActionSig：同一动作三路径产出同一签名", () => {
  // 命令/auto 检查路径：plan.action 结构
  assert.equal(
    upgradeActionSig({ kind: "local", label: "0.12.2-2 built 2026-10-22 17:28 (abc1234)" }),
    "local:0.12.2-2 built 2026-10-22 17:28 (abc1234)",
  );
  assert.equal(upgradeActionSig({ kind: "registry", version: "1.2.3" }), "registry:1.2.3");
  assert.equal(upgradeActionSig({ kind: "none", reason: "already at latest" }), "none:already at latest");
});

test("localUpgradeSig 与 plan 的 a.label 同口径（含 gitSha）", () => {
  const sig = localUpgradeSig({ version: "0.12.2-2", builtAt: "2026-10-22T17:28:00.000Z", gitSha: "abc1234" });
  assert.equal(sig, "local:0.12.2-2 built 2026-10-22 17:28 (abc1234)");
  // 与 upgradeActionSig 的 local 输出必须一致——这是 resolve 警告与计划去重能对上的全部前提。
  assert.equal(sig, upgradeActionSig({ kind: "local", label: "0.12.2-2 built 2026-10-22 17:28 (abc1234)" }));
});

test("mark/was：同签名去重、异签名不拦", () => {
  assert.equal(wasUpgradeSurfaced("local:X"), false);
  markUpgradeSurfaced("local:X");
  assert.equal(wasUpgradeSurfaced("local:X"), true);
  assert.equal(wasUpgradeSurfaced("registry:1"), false);
});
