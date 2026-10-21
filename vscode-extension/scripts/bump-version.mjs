#!/usr/bin/env node
// 扩展版本升版单点化：npm run bump <version> ——
// ① package.json version 落盘（这是唯一权威源：vsce 打包名、运行时
//    extVer、release-check 全从这里取）；
// ② 文档里硬编码的 pi-for-ide-<ver>.vsix 字面量同步换名
//    （README.md / docs/vscode-extension-deploy.md / readme*.md——
//     升版不改它们就一直在教用户装旧文件，0.1.0 已经滞留过）。
// CHANGELOG 不自动写——版本说明是人工内容，release-check 发包前会核。

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const extDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(extDir, "..");

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: npm run bump <version>  (e.g. 0.2.1 or 0.2.1-dev)");
  process.exit(1);
}

const pkgPath = join(extDir, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const old = pkg.version;
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`package.json: ${old} → ${version}`);

const VSIX_RE = /pi-for-ide-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.vsix/g;
const docs = [
  join(repoRoot, "README.md"),
  join(repoRoot, "docs", "vscode-extension-deploy.md"),
  join(extDir, "readme.md"),
  join(extDir, "readme.zh-CN.md"),
];
for (const file of docs) {
  const text = readFileSync(file, "utf8");
  const next = text.replace(VSIX_RE, `pi-for-ide-${version}.vsix`);
  if (next !== text) {
    writeFileSync(file, next);
    const count = (text.match(VSIX_RE) ?? []).length;
    console.log(`${file.split(/[\\/]/).pop()}: ${count} vsix reference(s) → ${version}`);
  }
}
console.log("done — CHANGELOG.md left for manual editing (release-check enforces it at publish).");
