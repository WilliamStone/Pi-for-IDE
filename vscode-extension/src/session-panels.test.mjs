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

const { SessionPanels } = await import("./session-panels.ts");

/** 假面板——只暴露注册表依赖的面：列归属/标题回调/生命周期。 */
function fakePanel() {
  const listeners = { disposed: null, bound: null };
  return {
    currentViewColumn: undefined,
    title: undefined,
    setTitleOverride(t) { this.title = t; },
    disposed: false,
    dispose() { this.disposed = true; listeners.disposed?.(); },
    fireBound(id, title) { listeners.bound?.(id, title); },
    _listeners: listeners,
  };
}

function makeRegistry() {
  const created = [];
  const registry = new SessionPanels({
    createPanel(onDisposed, onSessionBound) {
      const p = fakePanel();
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

test("dispose 的面板从注册表摘除（下次按键新建）", () => {
  const { registry, created } = makeRegistry();
  registry.forKey("s-a");
  created[0].dispose();
  const fresh = registry.forKey("s-a");
  assert.equal(created.length, 2);
  assert.notEqual(fresh, created[0]);
  assert.equal(fresh.disposed, false);
});

test("column()：首个面板列回落点；有面板后锚其列", () => {
  const { registry, created } = makeRegistry();
  assert.equal(registry.column(), 1, "空注册表回落 fallbackColumn");
  const p = registry.forKey("s-a");
  p.currentViewColumn = 3;
  assert.equal(registry.column(), 3, "后续 tab 锚定已开面板所在组");
});
