import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

// sessions-tree.ts → "vscode"（Disposable/EventEmitter/TreeItem 面）
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

const { SessionsTreeProvider } = await import("./sessions-tree.ts");

const session = (id, cwd = "/repo") => ({
  id,
  name: `name-${id}`,
  firstMessage: `msg-${id}`,
  cwd,
  projectRoot: cwd,
  created: "2026-01-01T00:00:00Z",
  modified: "2026-01-01T00:00:00Z",
});

const memento = () => ({ get: (_k, d) => d, update: async () => {} });

/** 可变快照的假服务——版本号/清单由场景脚本驱动。 */
function fakeServer() {
  const state = {
    listVersion: 1,
    uiRevision: 1,
    sessions: [session("s1")],
    running: [],
    awaiting: [],
  };
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (v) => ({ ok: true, json: async () => v });
    if (u.endsWith("/api/agent/running"))
      return json({
        sessionListVersion: state.listVersion,
        sessionUiStateRevision: state.uiRevision,
        runningSessionIds: state.running,
        awaitingInputSessionIds: state.awaiting,
      });
    if (u.endsWith("/api/sessions"))
      return json({
        sessions: state.sessions,
        runningSessionIds: state.running,
        awaitingInputSessionIds: state.awaiting,
      });
    if (u.endsWith("/api/sessions/ui-state")) return json({ state: {} });
    return { ok: false, status: 404 };
  };
  return { state, restore: () => { globalThis.fetch = orig; } };
}

test("回归：清单变了但 running/awaiting 没变，也必须 fire 重绘", async (t) => {
  // 曾踩：fire() 只在标志变化时调用 → 新会话拉到数据但树一直停旧视图。
  const { state, restore } = fakeServer();
  t.after(restore);
  const p = new SessionsTreeProvider(async () => "http://x", memento(), () => []);
  let fires = 0;
  p.onDidChangeTreeData(() => fires++);

  await p.reload();
  assert.equal(p.sessionById("s1")?.name, "name-s1");
  const firesAfterFirst = fires;
  assert.ok(firesAfterFirst > 0, "首次拉取应 fire");

  // 快照元数据不变、清单版本变 → 树必须重绘且拿到新数据。
  state.listVersion = 2;
  state.sessions = [session("s1"), session("s2")];
  await p.reload();
  assert.equal(p.sessionById("s2")?.name, "name-s2", "新会话进模型");
  assert.ok(fires > firesAfterFirst, "清单变化必须 fire——这正是坏掉的回归面");
});

test("awaiting/running 快照随轮询更新（状态栏指示器数据源）", async (t) => {
  const { state, restore } = fakeServer();
  t.after(restore);
  const p = new SessionsTreeProvider(async () => "http://x", memento(), () => []);
  state.running = ["s1"];
  state.awaiting = ["s1"];
  await p.reload();
  assert.deepEqual([...p.runningSessionIds], ["s1"]);
  assert.deepEqual([...p.awaitingSessionIds], ["s1"]);
});

test("kick 暖拍：不可见但清单未加载时放行，已加载则跳过", async (t) => {
  const { restore } = fakeServer();
  t.after(restore);
  let fetches = 0;
  const inner = globalThis.fetch;
  globalThis.fetch = async (u) => {
    fetches++;
    return inner(u);
  };
  const p = new SessionsTreeProvider(async () => "http://x", memento(), () => []);

  // 不可见 + 未加载 → 暖拍放行（可见性事件滞后时数据先备好）。
  p.kick();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(p.sessionById("s1")?.name, "name-s1", "暖拍已取回清单");
  assert.ok(fetches > 0, "确实发了请求");

  // 不可见 + 已加载 → 跳过（省流口径不变）。
  const afterWarm = fetches;
  p.kick();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fetches, afterWarm, "已暖后 kick 不再发请求");
});

test("启动中 → hint 区分 'is starting'，off↔starting 翻转也 fire", async () => {
  let starting = true;
  const p = new SessionsTreeProvider(async () => undefined, memento(), () => [], () => starting);
  const label = () => String(p.getChildren()[0]?.label);
  assert.match(label(), /is starting/);

  // starting → off：离线态也要 fire，否则提示停在旧文案
  let fires = 0;
  p.onDidChangeTreeData(() => fires++);
  starting = false;
  await p.reload();
  assert.equal(fires > 0, true, "off↔starting 翻转必须通知视图");
  assert.match(label(), /not running or is starting/);

  // off → starting：对称方向
  starting = true;
  await p.reload();
  assert.match(label(), /is starting/);
});

test("服务下线 → 清空会话且 fire（不滞旧）", async (t) => {
  const { restore } = fakeServer();
  t.after(restore);
  // 同一 provider：先有数据，再断 base——清空必须通知视图。
  let base = "http://x";
  const p = new SessionsTreeProvider(async () => base, memento(), () => []);
  await p.reload();
  assert.equal(p.sessionById("s1") !== undefined, true);

  base = undefined; // 服务下线——getBaseUrl 返空
  let fired = false;
  p.onDidChangeTreeData(() => (fired = true));
  await p.reload();
  assert.equal(p.sessionById("s1"), undefined, "下线后清单清空");
  assert.equal(fired, true, "下线转换也要通知视图");
});

test("启动阶段文案 → hint 带 stage，stage 切换也 fire", async () => {
  let stage = "Checking for a running server…";
  const p = new SessionsTreeProvider(
    async () => undefined,
    memento(),
    () => [],
    () => true,
    () => stage,
  );
  const label = () => String(p.getChildren()[0]?.label);
  assert.match(label(), /is starting.*Checking for a running server/);

  // 先拉一轮消化初次 off→starting 翻转（它自己就计一次 fire），
  // 落位 lastStarting/lastStartStage 后才能隔离 stage 变更的贡献。
  p.setVisible(true);
  await new Promise((r) => setTimeout(r, 30));

  // stage 变化（仍在启动中）也要通知视图——必须走 setVisible→tick 的
  // gated 路径才能隔离出来（reload() 自身无条件 fire，测不出）。
  let fires = 0;
  p.onDidChangeTreeData(() => fires++);
  stage = "Waiting for the server API…";
  p.setVisible(false);
  p.setVisible(true); // 立刻再踢一轮 tick
  await new Promise((r) => setTimeout(r, 30));
  p.setVisible(false);
  assert.equal(fires > 0, true, "stage 变化必须通知视图");
  assert.match(label(), /Waiting for the server API/);
});
