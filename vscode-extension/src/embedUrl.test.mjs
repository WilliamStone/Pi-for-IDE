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

const { buildEmbedUrl } = await import("./embedUrl.ts");

const BASE = { inst: "b1", extVer: "0.2.1" };

test("session 深链不带 cwd（?cwd= 会被页面当新草稿盖掉深链）", () => {
  const url = new URL(buildEmbedUrl("http://localhost:3000", { ...BASE, sessionId: "s1", cwd: "/repo" }));
  assert.equal(url.searchParams.get("session"), "s1");
  assert.equal(url.searchParams.get("cwd"), null);
  assert.equal(url.searchParams.get("embed"), "vscode");
  assert.equal(url.searchParams.get("extVer"), "0.2.1");
  assert.equal(url.searchParams.get("inst"), "b1");
});

test("无 session 时 cwd 照常发出", () => {
  const url = new URL(buildEmbedUrl("http://localhost:3000", { ...BASE, cwd: "/repo" }));
  assert.equal(url.searchParams.get("cwd"), "/repo");
  assert.equal(url.searchParams.get("session"), null);
});

test("view=chat 带 browserBtn=0/1；非 chat 不发该参数", () => {
  const on = new URL(buildEmbedUrl("http://x", { ...BASE, view: "chat", browserBtn: true }));
  assert.equal(on.searchParams.get("view"), "chat");
  assert.equal(on.searchParams.get("browserBtn"), "1");
  const off = new URL(buildEmbedUrl("http://x", { ...BASE, view: "chat", browserBtn: false }));
  assert.equal(off.searchParams.get("browserBtn"), "0");
  const plain = new URL(buildEmbedUrl("http://x", { ...BASE }));
  assert.equal(plain.searchParams.get("browserBtn"), null);
});

test("view=settings 带 section；section 不随其他 view 发出", () => {
  const s = new URL(buildEmbedUrl("http://x", { ...BASE, view: "settings", section: "models" }));
  assert.equal(s.searchParams.get("view"), "settings");
  assert.equal(s.searchParams.get("section"), "models");
  const chat = new URL(buildEmbedUrl("http://x", { ...BASE, view: "chat", section: "models" }));
  assert.equal(chat.searchParams.get("section"), null);
});

test("server 换实例 → URL 必不同（inst 防判重吞刷新）", () => {
  const a = buildEmbedUrl("http://localhost:3000", { ...BASE, inst: "b1", sessionId: "s" });
  const b = buildEmbedUrl("http://localhost:3000", { ...BASE, inst: "b2", sessionId: "s" });
  assert.notEqual(a, b);
});
