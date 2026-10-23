// invalidateIfBootMismatch 的单调性 + 所有权语义：
// - marker.boot 不新于本地 boot → 不动（旧标记不得倒踢新实例）
// - marker 更新 + 自 spawn 实例 → stop()（清理被取代的 spawn）
// - marker 更新 + attach 实例（无 child）→ release()，绝不可 stop()——
//   stop 对无 child 实例会 POST /api/embed/shutdown，杀掉共享服务器
//   （曾致双窗互杀死循环的实证 bug）。
import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

// piIdeServer.ts imports "vscode" — redirect to the stub (same pattern as
// bridge.test.mjs). Hooks must be installed before the dynamic import.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "vscode") {
      return {
        url: new URL("./test-vscode-stub.mjs", import.meta.url).href,
        shortCircuit: true,
      };
    }
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.(mjs|cjs|js|ts|json)$/.test(specifier)
    ) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

const { PiIdeServer } = await import("./piIdeServer.ts");

const g = /** @type {Record<string, unknown>} */ (globalThis);

function fakeServer({ embedBoot, child }) {
  return {
    embedBoot,
    child,
    disposed: false,
    stopCalls: 0,
    releaseCalls: 0,
    async stop() { this.stopCalls++; this.disposed = true; },
    release() { this.releaseCalls++; this.disposed = true; },
  };
}

test("same boot → untouched", async () => {
  const s = fakeServer({ embedBoot: "1000" });
  g.__piIdeServer = s;
  await PiIdeServer.invalidateIfBootMismatch("1000");
  assert.equal(s.stopCalls, 0);
  assert.equal(s.releaseCalls, 0);
});

test("older marker → untouched (stale marker must not evict a newer instance)", async () => {
  const s = fakeServer({ embedBoot: "2000" });
  g.__piIdeServer = s;
  await PiIdeServer.invalidateIfBootMismatch("1000");
  assert.equal(s.stopCalls, 0);
  assert.equal(s.releaseCalls, 0);
});

test("newer marker + spawned child → stop (superseded spawn cleanup)", async () => {
  const s = fakeServer({ embedBoot: "1000", child: { pid: 123 } });
  g.__piIdeServer = s;
  await PiIdeServer.invalidateIfBootMismatch("2000");
  assert.equal(s.stopCalls, 1);
  assert.equal(s.releaseCalls, 0);
});

test("newer marker + attached instance → release only, never stop", async () => {
  const s = fakeServer({ embedBoot: "1000" }); // no child = attached
  g.__piIdeServer = s;
  await PiIdeServer.invalidateIfBootMismatch("2000");
  assert.equal(s.releaseCalls, 1);
  assert.equal(s.stopCalls, 0); // 关键：绝不能 shutdown 共享服务器
});

test("no boot → untouched", async () => {
  const s = fakeServer({ embedBoot: "1000" });
  g.__piIdeServer = s;
  await PiIdeServer.invalidateIfBootMismatch(undefined);
  assert.equal(s.stopCalls + s.releaseCalls, 0);
});

test("non-numeric boot → untouched (degrade, don't evict)", async () => {
  const s = fakeServer({ embedBoot: "1000" });
  g.__piIdeServer = s;
  await PiIdeServer.invalidateIfBootMismatch("abc");
  assert.equal(s.stopCalls + s.releaseCalls, 0);
});
