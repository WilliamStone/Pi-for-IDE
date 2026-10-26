import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

// session-panels.ts 对 vscode/webviewProvider 全是 type 依赖——无 stub 需要。
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

const { SessionPanels, parsePiViewType } = await import("./session-panels.ts");

/** 假面板——只暴露注册表依赖的面：列归属/标题回调/生命周期/adopt。 */
function fakePanel() {
  const listeners = { disposed: null, bound: null };
  return {
    currentViewColumn: undefined,
    title: undefined,
    setTitleOverride(t) { this.title = t; },
    disposed: false,
    dispose() { this.disposed = true; listeners.disposed?.(); },
    fireBound(id, title) { listeners.bound?.(id, title); },
    adopted: undefined, // [rawPanel, state]
    adopt(panel, state) { this.adopted = [panel, state]; },
    _listeners: listeners,
  };
}

function makeRegistry() {
  const created = [];
  const registry = new SessionPanels({
    createPanel(viewType, onDisposed, onSessionBound) {
      const p = fakePanel();
      p.viewType = viewType;
      p._listeners.disposed = onDisposed;
      p._listeners.bound = onSessionBound;
      created.push(p);
      return p;
    },
    fallbackColumn: () => 1, // ViewColumn.Active
  });
  return { registry, created };
}

test("同键复用同面板；异键各开各的", () => {
  const { registry, created } = makeRegistry();
  const a1 = registry.forKey("s-a");
  const a2 = registry.forKey("s-a");
  const b = registry.forKey("s-b");
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.equal(created.length, 2);
});

test("composer(new:cwd) 落地成会话 → re-key 后点会话复用同一 tab", () => {
  const { registry, created } = makeRegistry();
  const composer = registry.forKey("new:/repo");
  // 页面在 composer 里建起会话 s-x → sessionSelected 回报
  created[0].fireBound("s-x", "fix the bug");
  const sessionTab = registry.forKey("s-x");
  assert.equal(sessionTab, composer, "re-key 后 session 键应指向同一面板");
  assert.equal(composer.title, "Pi — fix the bug");
});

test("re-key 到已存在会话键不抢（已有 tab 优先）", () => {
  const { registry, created } = makeRegistry();
  const existing = registry.forKey("s-a");
  registry.forKey("new:/repo");
  created[1].fireBound("s-a", "dup");
  assert.equal(registry.forKey("s-a"), existing, "既有会话 tab 不被顶掉");
});

test("byViewTypeUri：resource URI 内的 viewType 段精确反查面板", () => {
  const { registry } = makeRegistry();
  const a = registry.forKey("s-uuid-a");
  registry.forKey("new:/repo");
  const uri = (vt, rid = "1111-2222-3333-4444") =>
    `/webview-panel/webview-mainThreadWebview-${vt}-${rid}`;
  assert.equal(registry.byViewTypeUri(uri("piIde.webview.s.s-uuid-a")), a);
  // composer 是 n<seq> 型 viewType，同样命中
  assert.ok(registry.byViewTypeUri(uri("piIde.webview.n1")));
  // 非本扩展/未知 viewType → undefined（命令回退激活面板）
  assert.equal(registry.byViewTypeUri(uri("mainThreadWebview-other.x")), undefined);
});

test("dispose 的面板从注册表摘除（下次按键新建）", () => {
  const { registry, created } = makeRegistry();
  registry.forKey("s-a");
  created[0].dispose();
  const fresh = registry.forKey("s-a");
  assert.equal(created.length, 2);
  assert.notEqual(fresh, created[0]);
  assert.equal(fresh.disposed, false);
});

test("adopt：孤儿 tab 以既有 viewType 注册进键映射；URI 反查继续命中", async () => {
  const { registry, created } = makeRegistry();
  const orphan = { viewType: "piIde.webview.s.s-9", disposed: false, dispose() { this.disposed = true; } };
  const p = await registry.adopt("s-9", orphan, { sessionId: "s-9", cwd: "/repo" });
  assert.equal(registry.forKey("s-9"), p, "接管后点同会话复用它而非新开");
  assert.equal(p.viewType, "piIde.webview.s.s-9", "包装壳沿用既有面板 viewType");
  assert.deepEqual(p.adopted, [orphan, { sessionId: "s-9", cwd: "/repo" }]);
  assert.equal(
    registry.byViewTypeUri("/webview-panel/webview-mainThreadWebview-piIde.webview.s.s-9-uuid"),
    p,
  );
});

test("adopt：同键已有活面板时关掉多余孤儿，返回既有", async () => {
  const { registry } = makeRegistry();
  const live = registry.forKey("s-a");
  const orphan = { viewType: "piIde.webview.s.s-a", disposed: false, dispose() { this.disposed = true; } };
  const p = await registry.adopt("s-a", orphan, undefined);
  assert.equal(p, live);
  assert.equal(orphan.disposed, true);
});

test("parsePiViewType：各形态归类，前缀与非本扩展不命中", () => {
  assert.deepEqual(parsePiViewType("piIde.webview.s.abc-123"), { kind: "session", id: "abc-123" });
  assert.deepEqual(parsePiViewType("piIde.webview.n7"), { kind: "composer" });
  assert.deepEqual(parsePiViewType("piIde.webview.main"), { kind: "main" });
  assert.deepEqual(parsePiViewType("piIde.webview.settings"), { kind: "settings" });
  assert.deepEqual(parsePiViewType("piIde.webview"), { kind: "legacy" });
  assert.deepEqual(parsePiViewType("mainThreadWebview-piIde.webview.s.x"), { kind: "session", id: "x" });
  assert.equal(parsePiViewType("github.pr"), undefined);
  assert.equal(parsePiViewType("piIde.webview.other"), undefined);
});

test("column()：首个面板列回落点；有面板后锚其列", () => {
  const { registry, created } = makeRegistry();
  assert.equal(registry.column(), 1, "空注册表回落 fallbackColumn");
  const p = registry.forKey("s-a");
  p.currentViewColumn = 3;
  assert.equal(registry.column(), 3, "后续 tab 锚定已开面板所在组");
});
