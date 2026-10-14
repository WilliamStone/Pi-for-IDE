#!/usr/bin/env node
/**
 * 把 pi-web 的 standalone 产物打包进 VSCode 扩展目录。
 *
 * 构建与组装逻辑在仓库根的 scripts/prepare-standalone.js（npm 发布
 * 的 prepack 也走它）；本脚本只负责调用它并把产物目录复制到
 * `vscode-extension/resources/pi-web/`。
 *
 * 之后 `vsce package` 会把 `resources/pi-web/` 一起打进 `.vsix`（过渡期
 * 兼容路径——外部解析生效后打包步骤会移除它）。
 */
const cp = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..", "..");
const extRoot = path.join(repoRoot, "vscode-extension");
const targetDir = path.join(extRoot, "resources", "pi-web");

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function cpR(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true });
}

function du(p) {
  // 粗略统计目录大小（MB）。
  let total = 0;
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, entry.name);
    if (entry.isDirectory()) total += du(full);
    else total += fs.statSync(full).size;
  }
  return `${(total / 1024 / 1024).toFixed(1)}MB`;
}

function main() {
  // build 前先移走旧产物，避免 Next 把 resources/pi-web 下的源码副本当成
  // 项目文件编译（会导致 declare global 变量重复声明、类型冲突 build 失败）。
  const stashed = targetDir + ".__stash__";
  if (fs.existsSync(stashed)) rmrf(stashed);
  if (fs.existsSync(targetDir)) fs.renameSync(targetDir, stashed);
  try {
    const out = cp.execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "prepare-standalone.js")],
      { cwd: repoRoot, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] },
    );
    process.stdout.write(out);
    const marker = out.match(/STANDALONE_DIR=(.+)/);
    if (!marker) throw new Error("prepare-standalone.js 未输出 STANDALONE_DIR");
    const serverDir = marker[1].trim();

    rmrf(targetDir);
    fs.mkdirSync(targetDir, { recursive: true });
    cpR(serverDir, targetDir);

    console.log(`\n✓ 完成。${path.relative(repoRoot, targetDir)} 大小: ${du(targetDir)}`);
  } finally {
    if (fs.existsSync(stashed)) rmrf(stashed);
  }
}

main();
