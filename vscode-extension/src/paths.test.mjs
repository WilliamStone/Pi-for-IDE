import assert from "node:assert/strict";
import test from "node:test";
import { baseName, isAbsolutePath, isWithinCwd, normalizeAbsPath, pathKey, toGitRelPath } from "./paths.ts";

test("isAbsolutePath covers drive-letter, POSIX root and UNC", () => {
  assert.equal(isAbsolutePath("S:\\dir\\f.ts"), true);
  assert.equal(isAbsolutePath("s:/dir/f.ts"), true);
  assert.equal(isAbsolutePath("/posix/f"), true);
  assert.equal(isAbsolutePath("\\\\server\\share\\f"), true);
  assert.equal(isAbsolutePath("src/f.ts"), false);
  assert.equal(isAbsolutePath("./f.ts"), false);
});

test("normalizeAbsPath: Windows backslash absolute", () => {
  assert.equal(normalizeAbsPath("S:\\dir\\f.ts", "S:\\dir"), "S:/dir/f.ts");
  assert.equal(normalizeAbsPath("S:/dir/f.ts", "S:/dir"), "S:/dir/f.ts");
});

test("normalizeAbsPath: relative resolves against normalized cwd", () => {
  assert.equal(normalizeAbsPath("src/f.ts", "S:\\dir"), "S:/dir/src/f.ts");
  assert.equal(normalizeAbsPath("./f.ts", "S:/dir/"), "S:/dir/f.ts");
  assert.equal(normalizeAbsPath("../up.ts", "S:/dir/sub"), "S:/dir/up.ts");
  assert.equal(normalizeAbsPath("a.ts", "/w"), "/w/a.ts");
});

test("normalizeAbsPath: trailing slash cwd and absolute input with dots", () => {
  assert.equal(normalizeAbsPath("S:/dir/./f.ts", "x"), "S:/dir/f.ts");
});

test("isWithinCwd: boundary enforcement", () => {
  assert.equal(isWithinCwd("S:\\dir\\f.ts", "S:\\dir"), true);
  assert.equal(isWithinCwd("S:/dir", "S:/dir"), true);
  // `C:\proj` must NOT match folder `C:\pro` (path-boundary bug)
  assert.equal(isWithinCwd("C:\\proj\\f.ts", "C:\\pro"), false);
  assert.equal(isWithinCwd("/other/f", "/w"), false);
});

test("toGitRelPath strips cwd root (mixed separators)", () => {
  assert.equal(toGitRelPath("S:\\dir\\src\\a.ts", "S:/dir"), "src/a.ts");
  assert.equal(toGitRelPath("S:/dir", "S:/dir"), ".");
  // outside cwd → returned as-is (git show will fail → null before)
  assert.equal(toGitRelPath("S:/other/a.ts", "S:/dir"), "S:/other/a.ts");
});

test("baseName never returns a string containing ':'", () => {
  assert.equal(baseName("S:\\dir\\f.ts"), "f.ts");
  assert.equal(baseName("S:/dir/f.ts"), "f.ts");
  assert.equal(baseName("/p/f.ts"), "f.ts");
  assert.equal(baseName("f.ts"), "f.ts");
  assert.equal(baseName(""), "file");
});

test("pathKey gives a case-insensitive map key on win32, exact case elsewhere", () => {
  const isWin = process.platform === "win32";
  const a = pathKey("S:/DevSpace/Games/x.ts", "S:/DevSpace");
  const b = pathKey("s:/devspace/games/x.ts", "S:/DevSpace");
  assert.equal(a === b, isWin);
  // 相对输入也归一到同一键。
  assert.equal(pathKey("games\\x.ts", "S:/DevSpace") === a, isWin);
});
