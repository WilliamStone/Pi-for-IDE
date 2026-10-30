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
const { SessionsTreeProvider } = await import("./sessions-tree.ts");

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

const session = (id, cwd = "/repo") => ({
  id,
  name: `name-${id}`,
  firstMessage: `msg-${id}`,
  cwd,
  projectRoot: cwd,
  created: "2026-01-01T00:00:00Z",
  modified: "2026-01-01T00:00:00Z",
  messageCount: 7,
});

const memento = () => ({ get: (_k, d) => d, update: async () => {} });

function fakeServer(sessions) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (v) => ({ ok: true, json: async () => v });
    if (u.endsWith("/api/agent/running"))
      return json({ sessionListVersion: 1, sessionUiStateRevision: 1 });
    if (u.endsWith("/api/sessions")) return json({ sessions });
    if (u.endsWith("/api/sessions/ui-state")) return json({ state: {} });
    return { ok: false, status: 404 };
  };
  return { restore: () => { globalThis.fetch = orig; } };
}

test("metaLayout=line：meta 挪到独立副行，副行不带 id 不抢索引", async (t) => {
  const { restore } = fakeServer([session("s1"), session("s2")]);
  t.after(restore);
  const p = new SessionsTreeProvider(async () => "http://x", memento(), () => []);
  p.metaIconUri = { fsPath: "blank.svg" };
  await p.reload();
  // 默认 byProject：同 cwd 两会话归一组，组内 [session, meta] 成对。
  const group = p.getChildren()[0];
  const rows = group.sessionItems;
  assert.equal(rows.length, 4);
  const meta = rows[1];
  assert.equal(meta.contextValue, "piIde.meta");
  assert.equal(meta.iconPath?.fsPath, "blank.svg", "透明占位图标——meta 与标题同列");
  assert.equal(meta.id, undefined, "副行无 id——itemIndex/reveal 不索引");
  assert.match(String(meta.description), /ago · 7 msgs/);
  assert.doesNotMatch(String(meta.description), /^[\s└]/, "副行无前导缩进/分支符——顶格读 meta");
  assert.equal(rows[0].description, undefined, "meta 已挪走，主行不再内联");
  assert.equal(meta.command?.command, "piIde.session.open", "副行沿用打开命令");
});

test("折叠双态：setAllCollapsed 翻转组态与 allCollapsed 账目", async (t) => {
  const { restore } = fakeServer([session("s1", "/a"), session("s2", "/b")]);
  t.after(restore);
  const p = new SessionsTreeProvider(async () => "http://x", memento(), () => []);
  await p.reload();
  const groups = () => p.getChildren().filter((x) => x.group);

  assert.equal(groups().length, 2, "两 cwd → 两项目组");
  assert.equal(p.isAllCollapsed(), false, "未播种前默认展开态");
  assert.ok(groups().every((g) => g.collapsibleState === 2), "默认 Expanded");

  p.setAllCollapsed(true);
  assert.equal(p.isAllCollapsed(), true);
  assert.ok(groups().every((g) => g.collapsibleState === 1), "全部 Collapsed");

  const genIds = groups().map((g) => g.id);
  p.setAllCollapsed(false);
  assert.equal(p.isAllCollapsed(), false);
  assert.ok(groups().every((g) => g.collapsibleState === 2), "全部 Expanded");
  assert.notDeepEqual(
    groups().map((g) => g.id), genIds,
    "代际 id 每次切换都换新——VS Code 按 collapsibleState 重铺",
  );
});

test("折叠双态：手动折叠逐组记账，末组折完才算 allCollapsed", async (t) => {
  const { restore } = fakeServer([session("s1", "/a"), session("s2", "/b")]);
  t.after(restore);
  const p = new SessionsTreeProvider(async () => "http://x", memento(), () => []);
  await p.reload();
  const keys = p.getChildren().filter((x) => x.group).map((x) => x.group.key);
  assert.equal(keys.length, 2);

  p.noteCollapsed(keys[0]);
  assert.equal(p.isAllCollapsed(), false, "还剩一组展开");
  p.noteCollapsed(keys[1]);
  assert.equal(p.isAllCollapsed(), true, "末组折完 → 全折叠");
  p.noteExpanded(keys[0]);
  assert.equal(p.isAllCollapsed(), false);
});
