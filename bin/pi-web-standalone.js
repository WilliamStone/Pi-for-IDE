"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");

/**
 * 在 .next/standalone/ 下广度优先找 server.js（嵌套深度随构建目录而变）。
 * npm 发行包打的是 standalone 产物（自包含 node_modules，无符号链接）；
 * 仓库开发环境没有 standalone，返回 null 走 next start。
 */
function findStandaloneServer(root) {
  const dir = path.join(root, ".next", "standalone");
  if (!fs.existsSync(dir)) return null;
  const queue = [dir];
  while (queue.length) {
    const cur = queue.shift();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.name === "server.js") return full;
    }
  }
  return null;
}

/**
 * 重新物化 standalone 应用目录内 .next/node_modules/<pkg>-<hash> 目录：
 * 它们是 prepare-standalone 时固化的真实文件副本，真实包名可从其
 * package.json 的 name 字段读回，再从刚安装的 node_modules 覆盖。
 */
function rematerializeExternalLinks(serverDir, { log = console.log } = {}) {
  const hashedRoot = path.join(serverDir, ".next", "node_modules");
  if (!fs.existsSync(hashedRoot)) return;
  const refreshDir = (dir) => {
    const pkgJsonPath = path.join(dir, "package.json");
    if (!fs.existsSync(pkgJsonPath)) return;
    let name;
    try {
      name = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")).name;
    } catch {
      return;
    }
    const fresh = path.join(serverDir, "node_modules", ...name.split("/"));
    if (!name || !fs.existsSync(fresh)) return;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.cpSync(fresh, dir, { recursive: true, dereference: true });
    log(`  已刷新 ${name} 的固化副本`);
  };
  for (const entry of fs.readdirSync(hashedRoot, { withFileTypes: true })) {
    const full = path.join(hashedRoot, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("@")) {
      for (const sub of fs.readdirSync(full)) {
        const subPath = path.join(full, sub);
        if (fs.statSync(subPath).isDirectory()) refreshDir(subPath);
      }
    } else {
      refreshDir(full);
    }
  }
}

module.exports = { findStandaloneServer, rematerializeExternalLinks };
