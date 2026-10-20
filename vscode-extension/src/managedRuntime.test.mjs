import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";

// managedRuntime.ts imports "vscode" — redirect the specifier to our stub.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "vscode") {
      return {
        url: new URL("./test-vscode-stub.mjs", import.meta.url).href,
        shortCircuit: true,
      };
    }
    // 源码里的相对 import 不带扩展名（bundler/tsc 约定）——node 直跑要补 .ts
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.(mjs|cjs|js|ts|json)$/.test(specifier)
    ) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

const { pickVersionDirName, readTgzIdentity, resolveLocalPackagePath } = await import("./managedRuntime.ts");
const { pickInstallFlow } = await import("./server-resolve.ts");

const PKG = "@william_stone/pi-web-for-ide";

/** 伪装一个装好的版本目录：node_modules/<pkg>/bin/pi-web.js + pi-web-build.json。 */
function fakeInstall(versionsRoot, dirName, builtAt) {
  const pkgDir = path.join(versionsRoot, dirName, "node_modules", PKG);
  mkdirSync(path.join(pkgDir, "bin"), { recursive: true });
  writeFileSync(path.join(pkgDir, "bin", "pi-web.js"), "// stub\n");
  if (builtAt) {
    writeFileSync(path.join(pkgDir, "pi-web-build.json"), JSON.stringify({ builtAt }));
  }
}

test("pickVersionDirName: unstamped identity → plain version dir", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-mr-"));
  const pick = pickVersionDirName(root, PKG, { version: "0.12.2-1" });
  assert.equal(pick.dirName, "0.12.2-1");
  assert.equal(pick.reused, false);
});

test("pickVersionDirName: stamped build gets a build-slot dir", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-mr-"));
  const id = { version: "0.12.2-1", builtAt: "2026-10-20T09:30:11.000Z" };
  const pick = pickVersionDirName(root, PKG, id);
  assert.equal(pick.dirName, "0.12.2-1.b20261020093011");
  assert.equal(pick.reused, false);
});

test("pickVersionDirName: identical stamped build already installed → reuse", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-mr-"));
  const id = { version: "0.12.2-1", builtAt: "2026-10-20T09:30:11.000Z" };
  fakeInstall(root, "0.12.2-1.b20261020093011", "2026-10-20T09:30:11.000Z");
  const pick = pickVersionDirName(root, PKG, id);
  assert.equal(pick.dirName, "0.12.2-1.b20261020093011");
  assert.equal(pick.reused, true);
});

test("pickVersionDirName: same version newer build → its own slot, not reuse", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-mr-"));
  // 已有 registry 装的同版本（无戳）
  fakeInstall(root, "0.12.2-1");
  const id = { version: "0.12.2-1", builtAt: "2026-10-20T10:00:00.000Z" };
  const pick = pickVersionDirName(root, PKG, id);
  assert.equal(pick.dirName, "0.12.2-1.b20261020100000");
  assert.equal(pick.reused, false);
});

test("pickInstallFlow: local/registry lock to their own side", () => {
  assert.equal(pickInstallFlow("local", "0.1.0", "0.2.0"), "local");
  assert.equal(pickInstallFlow("registry", "0.2.0", "0.1.0"), "registry");
});

test("pickInstallFlow: auto/prefer-remote compare both; higher version wins", () => {
  // 本地版本高 → 本地；在线高 → 在线；本地缺席 → 在线；在线缺席 → 本地。
  assert.equal(pickInstallFlow("auto", "0.2.0", "0.1.0"), "local");
  assert.equal(pickInstallFlow("auto", "0.1.0", "0.2.0"), "registry");
  assert.equal(pickInstallFlow("auto", undefined, "0.2.0"), "registry");
  assert.equal(pickInstallFlow("auto", "0.2.0", undefined), "local");
  assert.equal(pickInstallFlow("prefer-remote", "0.2.0", "0.1.0"), "local");
  assert.equal(pickInstallFlow("prefer-remote", "0.1.0", "0.2.0"), "registry");
});

test("pickInstallFlow: version tie → auto picks local, prefer-remote picks registry", () => {
  assert.equal(pickInstallFlow("auto", "0.1.0", "0.1.0"), "local");
  assert.equal(pickInstallFlow("prefer-remote", "0.1.0", "0.1.0"), "registry");
});

/** 造最小 npm tgz（package/ 前缀布局 + 可选构建戳）——不依赖系统 tar。 */
function makeTgzBare(dir, name, fileName, version, builtAt) {
  const parts = [JSON.stringify({ name, version, piIde: { level: 3 } })];
  const files = [["package/package.json", parts[0]]];
  if (builtAt) files.push(["package/pi-web-build.json", JSON.stringify({ version, builtAt })]);
  const blocks = [];
  for (const [fname, content] of files) {
    const data = Buffer.from(content);
    const head = Buffer.alloc(512);
    head.write(fname, 0, 100);
    head.write("0000644", 100); head.write("0000000", 108); head.write("0000000", 116);
    head.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    head.write("00000000000", 136); head.write("0", 156);
    let sum = 0;
    for (const b of head) sum += b;
    head.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(head, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length));
  }
  const tgz = path.join(dir, `${fileName}.tgz`);
  writeFileSync(tgz, gzipSync(Buffer.concat(blocks)));
  return tgz;
}

test("resolveLocalPackagePath: file path passes through", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-lp-"));
  const tgz = makeTgzBare(dir, "@william_stone/pi-web-for-ide", "pkg-a", "0.12.2-1");
  assert.equal(resolveLocalPackagePath(tgz, PKG), tgz);
  assert.equal(resolveLocalPackagePath(path.join(dir, "missing.tgz"), PKG), undefined);
});

test("resolveLocalPackagePath: directory picks the newest matching build", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-lp-"));
  // 两个同包不同构建 + 一个别的包 + 一个非包文件 → 取 newer build。
  const older = makeTgzBare(dir, "@william_stone/pi-web-for-ide", "pkg-old", "0.12.2-1", "2026-10-20T01:00:00.000Z");
  const newer = makeTgzBare(dir, "@william_stone/pi-web-for-ide", "pkg-new", "0.12.2-1", "2026-10-20T09:00:00.000Z");
  makeTgzBare(dir, "someone-else", "other", "9.9.9");
  writeFileSync(path.join(dir, "notes.txt"), "not a package");
  const picked = resolveLocalPackagePath(dir, PKG);
  assert.equal(picked, newer);
  assert.notEqual(picked, older);
});

test("resolveLocalPackagePath: empty/mismatched directory → undefined", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-lp-"));
  makeTgzBare(dir, "someone-else", "other", "9.9.9");
  assert.equal(resolveLocalPackagePath(dir, PKG), undefined);
  assert.equal(resolveLocalPackagePath(path.join(dir, "no-such-dir"), PKG), undefined);
});

test("resolveLocalPackagePath: real repo directory resolves its own tarball", (t) => {
  const repo = path.resolve(import.meta.dirname, "..", "..");
  const expected = path.join(repo, "william_stone-pi-web-for-ide-0.12.2-1.tgz");
  if (!existsSync(expected)) {
    t.skip("no built tarball in repo root");
    return;
  }
  const picked = resolveLocalPackagePath(repo, PKG);
  assert.equal(picked, expected);
});

test("readTgzIdentity reads package identity + build stamp from the real tarball", (t) => {
  const tgz = path.resolve(import.meta.dirname, "..", "..", "william_stone-pi-web-for-ide-0.12.2-1.tgz");
  if (!existsSync(tgz)) {
    t.skip("no built tarball in repo root");
    return;
  }
  const id = readTgzIdentity(tgz);
  assert.ok(id, "identity should read");
  assert.equal(id.name, PKG);
  assert.equal(id.version, "0.12.2-1");
  assert.ok(id.level >= 1);
  assert.ok(id.builtAt, "build stamp should be embedded by --for-pack");
  assert.match(id.builtAt, /^\d{4}-\d{2}-\d{2}T/);
  console.log(`    tgz identity: ${id.version} built ${id.builtAt}${id.gitSha ? ` (${id.gitSha})` : ""}`);
});
