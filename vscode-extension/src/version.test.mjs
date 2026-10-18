import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  compareVersions,
  isNewerVersion,
  isSafePkgSpec,
  levelSupported,
  packageLevel,
  pickNewestSupported,
} from "./version.ts";

test("compareVersions orders semver + fork suffix", () => {
  assert.equal(compareVersions("0.12.2", "0.12.2"), 0);
  assert.equal(compareVersions("0.12.10", "0.12.9"), 1);
  assert.equal(compareVersions("0.12.2-1", "0.12.2"), 1);
  assert.equal(compareVersions("0.12.2-2", "0.12.2-10"), -1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  assert.equal(isNewerVersion("0.12.3", "0.12.2"), true);
  assert.equal(isNewerVersion("0.12.2", "0.12.2"), false);
});

test("levelSupported: missing counts as 1; above supported range rejected", () => {
  assert.equal(levelSupported(undefined), true);
  assert.equal(levelSupported(1), true);
  assert.equal(levelSupported(0), false);
  assert.equal(levelSupported(2), false);
});

test("isSafePkgSpec accepts npm names/scopes/versions, rejects shell metachars", () => {
  assert.equal(isSafePkgSpec("@william_stone/pi-web-for-ide"), true);
  assert.equal(isSafePkgSpec("@william_stone/pi-web-for-ide@0.12.2-1"), true);
  assert.equal(isSafePkgSpec("pi-web"), true);
  assert.equal(isSafePkgSpec("pi-web@latest"), true);
  assert.equal(isSafePkgSpec("foo;evil"), false);
  assert.equal(isSafePkgSpec("foo bar"), false);
  assert.equal(isSafePkgSpec("a&b"), false);
  assert.equal(isSafePkgSpec("a|b"), false);
  assert.equal(isSafePkgSpec("$(evil)"), false);
  assert.equal(isSafePkgSpec("`evil`"), false);
  assert.equal(isSafePkgSpec('a"b'), false);
  assert.equal(isSafePkgSpec(""), false);
});

test("packageLevel reads piIde.level from package.json", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-pkglevel-"));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ piIde: { level: 1 } }));
  assert.equal(packageLevel(dir), 1);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({}));
  assert.equal(packageLevel(dir), undefined);
  writeFileSync(path.join(dir, "package.json"), "{bad json");
  assert.equal(packageLevel(dir), undefined);
  assert.equal(packageLevel(path.join(dir, "nonexistent")), undefined);
});

test("pickNewestSupported picks the highest compatible version, ties keep pool order", () => {
  const mk = (name, version, level) => ({ name, version, level });
  const v = (i) => i.version;
  const l = (i) => i.level;

  // 核心回归：旧版全局包不得影子化更新的托管副本。
  const pool = [mk("global", "0.12.1"), mk("managed", "0.12.2")];
  assert.equal(pickNewestSupported(pool, v, l)?.name, "managed");

  // 反向顺序同样取新版——腿序不再当优先级。
  assert.equal(pickNewestSupported([...pool].reverse(), v, l)?.name, "managed");

  // 同版本并列保留池序（global 排在前）。
  const tied = [mk("global", "0.12.2"), mk("managed", "0.12.2")];
  assert.equal(pickNewestSupported(tied, v, l)?.name, "global");

  // 级别不支持的新版输给支持的旧版。
  const mixed = [mk("managed", "0.99.0", 99), mk("global", "0.12.1", 1)];
  assert.equal(pickNewestSupported(mixed, v, l)?.name, "global");

  // 全不支持/空池 → undefined（交给安装兜底）。
  assert.equal(pickNewestSupported([mk("managed", "0.99.0", 99)], v, l), undefined);
  assert.equal(pickNewestSupported([], v, l), undefined);
});
