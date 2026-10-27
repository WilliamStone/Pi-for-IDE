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

const { OrphanRegistry, registerOrphanPanelRevival } = await import("./panel-revival.ts");
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

/** 桩共享的 tabGroups/calls2 每例重置。 */
function setup(t, tabs, { viewColumn = 2, sessionExists } = {}) {
  stub.tabGroups.all.length = 0;
  const group = { tabs, viewColumn };
  for (const t0 of tabs) t0.group = group;
  stub.tabGroups.all.push(group);
  stub.calls2.serializers.clear();
  stub.calls2.closedTabs.length = 0;
  const calls = { log: [] };
  const created = [];
  const context = { subscriptions: [] };
  const orphans = new OrphanRegistry();
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
    orphans,
    sessionExists,
    log: (l) => calls.log.push(l),
  });
  t.after(() => {
    for (const d of context.subscriptions) d.dispose();
  });
  return { calls, sessionPanels, created, orphans };
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

test("可收养孤儿留作懒占位——枚举不关不重开", async (t) => {
  setup(t, [orphanTab("piIde.webview.s.sess-keep")]);
  await tick();
  assert.deepEqual(stub.calls2.closedTabs, [], "session 孤儿永不扫尾");
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

test("deserialize 收养的孤儿从登记处摘除（带前缀形态也归一）", async (t) => {
  const { orphans } = setup(t, [orphanTab("piIde.webview.s.sess-pref")]);
  await stub.calls2.serializers
    .get("piIde.webview.s.sess-pref")
    .deserializeWebviewPanel(
      { viewType: "mainThreadWebview-piIde.webview.s.sess-pref", dispose() {} },
      {},
    );
  assert.equal(orphans.takeSession("sess-pref"), undefined, "已收养不再可被交换");
});

test("sessionExists=false → deserialize 关窗自清理；undefined → 乐观收养", async (t) => {
  const { created } = setup(t, [orphanTab("piIde.webview.s.sess-gone")], {
    sessionExists: (id) => (id === "sess-gone" ? false : undefined),
  });
  const gone = {
    viewType: "piIde.webview.s.sess-gone",
    disposed: false,
    dispose() { this.disposed = true; },
  };
  await stub.calls2.serializers
    .get("piIde.webview.s.sess-gone")
    .deserializeWebviewPanel(gone, {});
  assert.equal(gone.disposed, true, "清单已载而查无此会话——关占位");
  assert.equal(created.length, 0, "不进注册表");
});

test("登记处：takeSession 取出即摘除，手关同步摘除", async (t) => {
  const tab = orphanTab("piIde.webview.s.sess-swap");
  const { orphans } = setup(t, [tab]);
  const taken = orphans.takeSession("sess-swap");
  assert.equal(taken?.tab, tab, "交换方拿到孤儿本体");
  assert.equal(orphans.takeSession("sess-swap"), undefined, "取出即摘除");

  const tab2 = orphanTab("piIde.webview.s.sess-close");
  const { orphans: orphans2 } = setup(t, [tab2]);
  await stub.tabGroups.close(tab2); // 用户手关：closed 事件触发摘除
  assert.equal(orphans2.takeSession("sess-close"), undefined, "手关后不再可交换");
});

test("takeKind 按 main/settings 取孤儿", (t) => {
  const { orphans } = setup(t, [
    orphanTab("piIde.webview.main"),
    orphanTab("piIde.webview.settings"),
  ]);
  assert.equal(orphans.takeKind("main")?.rawVt, "piIde.webview.main");
  assert.equal(orphans.takeKind("settings")?.rawVt, "piIde.webview.settings");
  assert.equal(orphans.takeKind("composer"), undefined);
});

test("legacy 裸 piIde.webview 孤儿不注册不留占位——枚举即关", (t) => {
  const tab = orphanTab("mainThreadWebview-piIde.webview");
  const { orphans } = setup(t, [tab]);
  assert.equal(stub.calls2.serializers.size, 0);
  assert.deepEqual(stub.calls2.closedTabs, [tab], "身份不可考——枚举即关");
  assert.equal(orphans.size, 0, "不进登记处");
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
