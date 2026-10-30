#!/usr/bin/env node
// 开发构建打戳：临时把版本写成 <base>+dev.<yyyymmddhhmmss> 打包，再
// 还原 package.json 原文。
//
// 为什么用 + 而不是 -：`+dev.N` 是 semver build metadata，版本序仍
// 等于 <base>（-dev 会被判为 prerelease 降级）；但 vsix 文件名与安装
// 目录名（<id>-0.3.0+dev.<戳>）每次都不同——装出来一定是新目录，从
// 机制上杜绝"同号 vsix 装了旧内容"的歧义。
//
// 正式发布走 npm run package（净版本，仓库内 package.json 始终是它）。

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const extDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(extDir, "package.json");
const raw = readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(raw);

const base = pkg.version.split("+")[0]; // 已含 build metadata 时回到基线
const d = new Date();
const pad = (n) => String(n).padStart(2, "0");
const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const version = `${base}+dev.${stamp}`;

pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
try {
  const vsce = join(extDir, "node_modules", "@vscode", "vsce", "vsce");
  const r = spawnSync(process.execPath, [vsce, "package", "--no-yarn", "--no-dependencies", "--skip-license"], {
    cwd: extDir,
    stdio: "inherit",
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
} finally {
  writeFileSync(pkgPath, raw); // 无论成败还原净版本
}
console.log(`\ndev build → pi-for-ide-${version}.vsix`);
