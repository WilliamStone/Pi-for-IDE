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
  await p.reload();
  // 默认 byProject：同 cwd 两会话归一组，组内 [session, meta] 成对。
  const group = p.getChildren()[0];
  const rows = group.sessionItems;
  assert.equal(rows.length, 4);
  const meta = rows[1];
  assert.equal(meta.contextValue, "piIde.meta");
  assert.equal(meta.id, undefined, "副行无 id——itemIndex/reveal 不索引");
  assert.match(String(meta.description), /ago · 7 msgs/);
  assert.equal(rows[0].description, undefined, "meta 已挪走，主行不再内联");
  assert.equal(meta.command?.command, "piIde.session.open", "副行沿用打开命令");
});
