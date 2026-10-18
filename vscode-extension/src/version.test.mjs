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
