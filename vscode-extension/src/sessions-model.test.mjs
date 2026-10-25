import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

// 源码里的相对 import 不带扩展名（bundler/tsc 约定）——node 直跑要补 .ts
registerHooks({
  resolve(specifier, context, next) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.(mjs|cjs|js|ts|json)$/.test(specifier)
    ) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

const {
  isInWorkspace,
  sessionTitle,
  topLevelSessions,
  groupByProject,
  recentSessions,
  relTime,
  workspaceRelation,
} = await import("./sessions-model.ts");

const s = (id, over = {}) => ({
  id,
  created: "2026-10-20T10:00:00Z",
  modified: "2026-10-20T12:00:00Z",
  messageCount: 3,
  ...over,
});

test("isInWorkspace: cwd 在任一 root 子树内（含根）即属于工作区", () => {
  const roots = ["S:\\DevSpace\\AI", "/home/me/proj"];
  assert.equal(isInWorkspace(s("1", { cwd: "S:\\DevSpace\\AI" }), roots), true);
  assert.equal(isInWorkspace(s("1", { cwd: "S:/DevSpace/AI/Agents/pi-code" }), roots), true);
  assert.equal(isInWorkspace(s("1", { cwd: "S:\\DevSpace\\OTHER" }), roots), false);
  assert.equal(isInWorkspace(s("1", { cwd: "/home/me/proj/sub" }), roots), true);
  assert.equal(isInWorkspace(s("1", { cwd: undefined, projectRoot: "S:\\DevSpace\\AI\\x" }), roots), true);
  assert.equal(isInWorkspace(s("1", {}), roots), false);
  // 前缀粘连不算——/proj2 不在 /proj 内
  assert.equal(isInWorkspace(s("1", { cwd: "/home/me/proj2" }), roots), false);
});

test("workspaceRelation: 同根/子树/外部三态，驱动目录类操作显隐", () => {
  const roots = ["S:\\DevSpace\\AI", "/home/me/proj"];
  assert.equal(workspaceRelation("S:\\DevSpace\\AI", roots), "same");
  assert.equal(workspaceRelation("S:/DevSpace/AI/", roots), "same"); // 分隔符/尾斜杠归一
  if (process.platform === "win32") {
    assert.equal(workspaceRelation("s:\\devspace\\ai", roots), "same"); // win32 忽略大小写
  }
  assert.equal(workspaceRelation("S:\\DevSpace\\AI\\Agents\\pi-code", roots), "sub");
  assert.equal(workspaceRelation("/home/me/proj/sub", roots), "sub");
  assert.equal(workspaceRelation("S:\\DevSpace\\OTHER", roots), "out");
  assert.equal(workspaceRelation("/home/me/proj2", roots), "out"); // 前缀粘连不算子树
  assert.equal(workspaceRelation(undefined, roots), null);
  assert.equal(workspaceRelation(null, roots), null);
  // 无工作区根 → 全部视为外部（新窗/终端可用，Explorer 定位隐去）
  assert.equal(workspaceRelation("S:\\anywhere", []), "out");
});

test("topLevelSessions: subagent 会话被过滤", () => {
  const list = [
    s("a"),
    s("b", { relation: { kind: "subagent" } }),
    s("c", { relation: { kind: "fork" } }),
  ];
  assert.deepEqual(topLevelSessions(list).map((x) => x.id), ["a", "c"]);
});

test("groupByProject: 按 projectRoot 分组、组内按 modified 降序、组序取最新", () => {
  const list = groupByProject([
    s("old", { projectRoot: "/p1", modified: "2026-10-20T08:00:00Z" }),
    s("new", { projectRoot: "/p2", modified: "2026-10-20T12:00:00Z" }),
    s("mid", { projectRoot: "/p1", modified: "2026-10-20T10:00:00Z" }),
  ]);
  assert.deepEqual(list.map((g) => g.key), ["/p2", "/p1"]);
  assert.deepEqual(list[1].sessions.map((x) => x.id), ["mid", "old"]);
  assert.equal(list[0].label, "p2");
});

test("sessionTitle: 命名 > 首消息 > 兜底", () => {
  assert.equal(sessionTitle(s("1", { name: "  my fix " })), "my fix");
  assert.equal(sessionTitle(s("1", { firstMessage: "line1\nline2   x" })), "line1 line2 x");
  assert.equal(sessionTitle(s("1", { firstMessage: "x".repeat(80) })), `${"x".repeat(57)}…`);
  assert.equal(sessionTitle(s("1")), "(untitled)");
});

test("recentSessions: modified 降序截断", () => {
  const out = recentSessions([
    s("a", { modified: "2026-10-19T00:00:00Z" }),
    s("b", { modified: "2026-10-20T00:00:00Z" }),
    s("c", { modified: "2026-10-18T00:00:00Z" }),
  ], 2);
  assert.deepEqual(out.map((x) => x.id), ["b", "a"]);
});

test("relTime: 阶梯文案", () => {
  const now = new Date("2026-10-20T12:00:00Z").getTime();
  assert.equal(relTime("2026-10-20T11:59:40Z", now), "just now");
  assert.equal(relTime("2026-10-20T11:40:00Z", now), "20m ago");
  assert.equal(relTime("2026-10-20T08:00:00Z", now), "4h ago");
  assert.equal(relTime("2026-10-17T12:00:00Z", now), "3d ago");
  assert.equal(relTime("2026-10-06T12:00:00Z", now), "2w ago");
  assert.equal(relTime("2026-08-20T12:00:00Z", now), "2mo ago");
});
