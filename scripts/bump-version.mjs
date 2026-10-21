#!/usr/bin/env node
// npm 包版本升版单点化：npm run bump <version>（根目录）——
// ① package.json version 落盘（唯一权威源：tgz 文件名、pi-web-build.json
//    build 戳、NEXT_PUBLIC_APP_VERSION、release-check 全从这里取）；
// ② 文档里硬编码的 pi-web-for-ide-<ver>.tgz 字面量同步换名
//    （README.md / docs/README.* / deploy 指南——上次 0.12.1 滞留过）。
// CHANGELOG/发版说明不自动写；本仓版本号已自带语义 <上游base>-<迭代号>。

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+-\d+$/.test(version)) {
  console.error("usage: npm run bump <version>  (fork scheme: <upstream-base>-<iter>, e.g. 0.12.2-3)");
  process.exit(1);
}

const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const old = pkg.version;
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`package.json: ${old} → ${version}`);

const TGZ_RE = /pi-web-for-ide-\d+\.\d+\.\d+(?:-\d+)?\.tgz/g;
const docs = [
  "README.md",
  "docs/README.zh-CN.md",
  "docs/README.ja.md",
  "docs/README.ru.md",
  "docs/vscode-extension-deploy.md",
];
for (const rel of docs) {
  const file = join(root, rel);
  const text = readFileSync(file, "utf8");
  const next = text.replace(TGZ_RE, `pi-web-for-ide-${version}.tgz`);
  if (next !== text) {
    writeFileSync(file, next);
    const count = (text.match(TGZ_RE) ?? []).length;
    console.log(`${rel}: ${count} tgz reference(s) → ${version}`);
  }
}
console.log("done — run npm pack / npm stage publish next (release-check verifies the artifact).");
