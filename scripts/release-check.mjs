#!/usr/bin/env node
// Pre-publish fingerprint check: verifies the artifacts on disk actually
// contain the versions the manifests claim — catches "packaged before the
// final edit landed" accidents (e.g. a stale changelog shipping in a vsix).
// Run before ovsx/vsce/npm publish. Exits non-zero on any failure.

import { readFileSync, existsSync } from "node:fs";
import { inflateRawSync, gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const ok = (label, detail) => console.log(`  ✓ ${label}: ${detail}`);
const fail = (label, detail) => { failures.push(`${label}: ${detail}`); console.log(`  ✗ ${label}: ${detail}`); };

/* ---------- minimal zip reader (vsix) ---------- */
function zipEntry(buffer, wanted) {
  // End of central directory record (PK\x05\x06), searched from the tail.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buffer.readUInt16LE(eocd + 10);
  let off = buffer.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(off) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(off + 10);
    const size = buffer.readUInt32LE(off + 24);
    const nameLen = buffer.readUInt16LE(off + 28);
    const extraLen = buffer.readUInt16LE(off + 30);
    const commentLen = buffer.readUInt16LE(off + 32);
    const localOff = buffer.readUInt32LE(off + 42);
    const name = buffer.toString("utf8", off + 46, off + 46 + nameLen);
    if (name === wanted) {
      const lNameLen = buffer.readUInt16LE(localOff + 26);
      const lExtraLen = buffer.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buffer.subarray(dataStart, dataStart + buffer.readUInt32LE(off + 20));
      const data = method === 8 ? inflateRawSync(raw) : raw;
      return data.subarray(0, size);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/* ---------- minimal tar reader (tgz) ---------- */
function* tarEntries(buffer) {
  let off = 0;
  while (off + 512 <= buffer.length) {
    const name = buffer.toString("utf8", off, off + 100).replace(/\0.*$/, "");
    if (!name) break;
    const size = parseInt(buffer.toString("utf8", off + 124, off + 136).trim(), 8) || 0;
    yield { name, data: buffer.subarray(off + 512, off + 512 + size) };
    off += 512 + Math.ceil(size / 512) * 512;
  }
}

/* ---------- extension vsix ---------- */
const extPkg = JSON.parse(readFileSync(join(root, "vscode-extension/package.json"), "utf8"));
const vsix = join(root, "vscode-extension", `pi-for-ide-${extPkg.version}.vsix`);
console.log(`Extension: ${extPkg.name}@${extPkg.version}`);
if (!existsSync(vsix)) {
  fail("vsix", `${vsix} missing — run npm run package first`);
} else {
  const zip = readFileSync(vsix);
  const changelog = zipEntry(zip, "extension/changelog.md")?.toString("utf8") ?? zipEntry(zip, "extension/CHANGELOG.md")?.toString("utf8");
  const topVersion = changelog?.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1];
  if (topVersion === extPkg.version) ok("changelog top", topVersion);
  else fail("changelog top", `vsix changelog heads [${topVersion ?? "?"}] but package.json is ${extPkg.version}`);
  const inner = zipEntry(zip, "extension/package.json");
  const innerVer = inner ? JSON.parse(inner.toString("utf8")).version : null;
  if (innerVer === extPkg.version) ok("vsix manifest version", innerVer);
  else fail("vsix manifest version", `${innerVer ?? "?"} != ${extPkg.version}`);
}

/* ---------- web tarball ---------- */
const webPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tgzName = `${webPkg.name.replace(/^@/, "").replace("/", "-")}-${webPkg.version}.tgz`;
const tgz = join(root, tgzName);
console.log(`Web package: ${webPkg.name}@${webPkg.version}`);
if (!existsSync(tgz)) {
  fail("tgz", `${tgzName} missing — run npm pack first`);
} else {
  const stamp = [...tarEntries(gunzipSync(readFileSync(tgz)))].find((e) => e.name === "package/pi-web-build.json");
  if (!stamp) {
    fail("build stamp", "package/pi-web-build.json absent");
  } else {
    const meta = JSON.parse(stamp.data.toString("utf8"));
    if (meta.name === webPkg.name && meta.version === webPkg.version) ok("build stamp", `${meta.version} @ ${meta.builtAt} (${meta.gitSha ?? "no sha"})`);
    else fail("build stamp", `stamp ${meta.name}@${meta.version} != package.json ${webPkg.name}@${webPkg.version}`);
  }
}

if (failures.length) {
  console.error(`\nrelease-check FAILED (${failures.length}): do not publish.`);
  process.exit(1);
}
console.log("\nrelease-check passed — artifacts match their manifests.");
