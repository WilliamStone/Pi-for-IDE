import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !specifier.endsWith(".ts") &&
      !specifier.endsWith(".mjs")
    ) {
      return { url: new URL(specifier + ".ts", context.parentURL).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { getInitialNavigation, withTabOpen, linkedSessionId } =
  await import("./initial-navigation.ts");

const params = (s) => new URLSearchParams(s);

// 这组用例与扩展侧 embedUrl.test.mjs 对同一契约的两端——构造方不发
// cwd+session 同传，解析方就算收到也偏向 cwd（草稿覆盖深链）。
test("?session= → sessionId 深链", () => {
  const nav = getInitialNavigation(params("session=s1"));
  assert.equal(nav.sessionId, "s1");
  assert.equal(nav.requestedCwd, null);
});

test("?cwd= → requestedCwd（新会话草稿）", () => {
  const nav = getInitialNavigation(params("cwd=%2Frepo"));
  assert.equal(nav.requestedCwd, "/repo");
  assert.equal(nav.sessionId, null);
});

test("cwd+session 同传 → cwd 胜（草稿覆盖深链——历史 bug 钉死）", () => {
  const nav = getInitialNavigation(params("cwd=%2Frepo&session=s1"));
  assert.equal(nav.sessionId, null);
  assert.equal(nav.requestedCwd, "/repo");
});

test("withTabOpen：URL 无指向时恢复 tab 记忆的会话", () => {
  const nav = getInitialNavigation(params(""));
  const merged = withTabOpen(nav, { kind: "session", sessionId: "s9" });
  assert.equal(merged.sessionId, "s9");
  assert.equal(merged.sessionFromTab, true);
  // URL 已指向会话/cwd 时 tab 记忆不覆盖
  const pinned = getInitialNavigation(params("session=s1"));
  assert.equal(withTabOpen(pinned, { kind: "session", sessionId: "s9" }).sessionId, "s1");
});

test("withTabOpen：new 记忆恢复 cwd 草稿", () => {
  const nav = getInitialNavigation(params(""));
  const merged = withTabOpen(nav, { kind: "new", cwd: "/repo" });
  assert.equal(merged.requestedCwd, "/repo");
});

test("linkedSessionId：tab 记忆的会话不算深链", () => {
  const fromUrl = getInitialNavigation(params("session=s1"));
  assert.equal(linkedSessionId(fromUrl), "s1");
  const fromTab = withTabOpen(getInitialNavigation(params("")), { kind: "session", sessionId: "s9" });
  assert.equal(linkedSessionId(fromTab), null);
});
