import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

// panel-revival.ts 运行时依赖 vscode（tabGroups / serializer / TabInputWebview
// instanceof）——重定向到 node 桩。
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

const { registerOrphanPanelRevival } = await import("./panel-revival.ts");
const { SessionPanels } = await import("./session-panels.ts");
const stub = await import("./test-vscode-stub.mjs");

function fakeWrapper() {
  return {
    adopted: undefined, // [panel, state, fallbackSessionId]
    adopt(panel, state, fallbackSessionId) {
      this.adopted = [panel, state, fallbackSessionId];
    },
    dispose() {},
  };
}

function orphanTab(viewType, label = "orphan") {
  return { input: new stub.TabInputWebview(viewType), label };
}

/** 桩共享的 tabGroups/calls2 每例重置；sweepGraceMs: 0 让扫尾下个 tick 就跑。
 *  计时器挂在 context.subscriptions 上——测试不 dispose 会跨用例串台
 *  （上个用例的扫尾在本用例的 tick 里才跑）。 */
function setup(t, tabs, viewColumn = 2) {
  stub.tabGroups.all.length = 0;
  const group = { tabs, viewColumn };
  for (const t0 of tabs) t0.group = group;
  stub.tabGroups.all.push(group);
  stub.calls2.serializers.clear();
  stub.calls2.closedTabs.length = 0;
  const calls = { reopenSession: [], reopenMain: 0, reopenSettings: 0, log: [] };
  const created = [];
  const context = { subscriptions: [] };
  const sessionPanels = new SessionPanels({
    createPanel(viewType) {
      const p = fakeWrapper();
      p.viewType = viewType;
      created.push(p);
      return p;
    },
    fallbackColumn: () => 1,
  });
  registerOrphanPanelRevival(context, {
      sessionPanels,
      mainPanel: fakeWrapper(),
      settingsPanel: fakeWrapper(),
      reopenSession: (id, orphan) => void calls.reopenSession.push({ id, orphan }),
      reopenMain: () => void calls.reopenMain++,
      reopenSettings: () => void calls.reopenSettings++,
      log: (l) => calls.log.push(l),
      sweepGraceMs: 0,
    },
  );
  t.after(() => {
    for (const d of context.subscriptions) d.dispose();
  });
  return { calls, sessionPanels, created };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

test("枚举到的 pi webview tab 按裸 viewType 注册 serializer", (t) => {
  setup(t, [orphanTab("mainThreadWebview-piIde.webview.s.sess-1")]);
  assert.ok(
    stub.calls2.serializers.has("piIde.webview.s.sess-1"),
    "mainThreadWebview- 前缀剥掉后注册",
  );
});

test("同 viewType 两个孤儿 tab 只注册一次", (t) => {
  setup(t, [
    orphanTab("piIde.webview.s.same"),
    orphanTab("mainThreadWebview-piIde.webview.s.same"),
  ]);
  assert.equal(stub.calls2.serializers.size, 1);
});

test("deserialize 命中 session viewType → 注册表按会话键收养", async (t) => {
  const { sessionPanels, created } = setup(t, [orphanTab("piIde.webview.s.sess-9")]);
  const serializer = stub.calls2.serializers.get("piIde.webview.s.sess-9");
  const panel = { viewType: "piIde.webview.s.sess-9", dispose() {} };
  await serializer.deserializeWebviewPanel(panel, { sessionId: "sess-9", cwd: "/w" });
  assert.equal(created.length, 1);
  assert.equal(created[0].adopted[0], panel, "收养的是 deserialize 给的面板本体");
  assert.equal(created[0].adopted[2], "sess-9", "会话键作 fallback 身份");
  assert.equal(sessionPanels.forKey("sess-9"), created[0], "键已映射——点会话复用不重开");
});

test("deserialize 面板 viewType 带前缀时 revived 标记仍与裸键对齐", async (t) => {
  const tab = orphanTab("piIde.webview.s.sess-pref");
  setup(t, [tab]);
  // 平台若把 providerId 形态塞回 panel.viewType，收养标记按裸值对齐——
  // 否则扫尾会把已成功收养的活 tab 当孤儿关掉。
  await stub.calls2.serializers
    .get("piIde.webview.s.sess-pref")
    .deserializeWebviewPanel(
      { viewType: "mainThreadWebview-piIde.webview.s.sess-pref", dispose() {} },
      {},
    );
  await tick();
  assert.deepEqual(stub.calls2.closedTabs, [], "已收养的 tab 不被扫尾");
});

test("宽限期后未被 deserialize 认领的孤儿：关掉并按 kind 重开（带死 tab 现场）", async (t) => {
  const tab = orphanTab("piIde.webview.s.sess-2", "Pi — sess two");
  const { calls } = setup(t, [tab]);
  await tick();
  assert.deepEqual(stub.calls2.closedTabs, [tab]);
  assert.deepEqual(calls.reopenSession, [
    { id: "sess-2", orphan: { label: "Pi — sess two", viewColumn: 2 } },
  ]);
});

test("deserialize 过的孤儿不被扫尾（原地收养，不动 tab）", async (t) => {
  setup(t, [orphanTab("piIde.webview.s.sess-3")]);
  await stub.calls2.serializers
    .get("piIde.webview.s.sess-3")
    .deserializeWebviewPanel(
      { viewType: "piIde.webview.s.sess-3", dispose() {} },
      { sessionId: "sess-3" },
    );
  await tick();
  assert.deepEqual(stub.calls2.closedTabs, []);
});

test("宽限期内用户手动关掉的孤儿不重开", async (t) => {
  const tab = orphanTab("piIde.webview.s.sess-4");
  const { calls } = setup(t, [tab]);
  await stub.tabGroups.close(tab); // 用户手动关：closed 事件 + tab 移出
  stub.calls2.closedTabs.length = 0;
  await tick();
  assert.deepEqual(stub.calls2.closedTabs, [], "扫尾不再动它");
  assert.deepEqual(calls.reopenSession, [], "不重开用户显式关掉的 tab");
});

test("legacy 裸 piIde.webview 孤儿不注册 serializer，扫尾只关不重开", async (t) => {
  const tab = orphanTab("mainThreadWebview-piIde.webview");
  const { calls } = setup(t, [tab]);
  assert.equal(stub.calls2.serializers.size, 0);
  await tick();
  assert.deepEqual(stub.calls2.closedTabs, [tab]);
  assert.equal(
    calls.reopenSession.length + calls.reopenMain + calls.reopenSettings,
    0,
    "无身份可考——只关不重开",
  );
});

test("composer 孤儿按 state 落键：无身份则关，有 cwd 按 new:<cwd> 收养", async (t) => {
  const { created } = setup(t, [orphanTab("piIde.webview.n7")]);
  const serializer = stub.calls2.serializers.get("piIde.webview.n7");
  assert.ok(serializer);

  const dead = {
    viewType: "piIde.webview.n7",
    disposed: false,
    dispose() { this.disposed = true; },
  };
  await serializer.deserializeWebviewPanel(dead, {});
  assert.equal(dead.disposed, true, "state 全空的 composer 救不回——关掉");
  assert.equal(created.length, 0, "不进注册表");

  const live = { viewType: "piIde.webview.n7", dispose() {} };
  await serializer.deserializeWebviewPanel(live, { cwd: "/proj" });
  assert.equal(created.length, 1);
  assert.equal(created[0].adopted[0], live);
  assert.deepEqual(created[0].adopted[1], { cwd: "/proj" });
  assert.equal(created[0].adopted[2], undefined, "new: 键不给 sessionId fallback");
});
