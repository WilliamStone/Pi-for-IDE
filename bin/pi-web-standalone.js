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
 * 把 standalone 应用目录内 `.next/node_modules/<pkg>-<hash>` 目录换为
 * 指向 `node_modules/<pkg>` trace 副本的 junction/symlink。
 * pi-web 的 SDK 自检（lib/pi-sdk-internals.ts importPiSdkInternals）
 * 用 realpath 比对"bundle 解析到的外部包"与"Node 从应用目录解析到
 * 的同名包"——两份实目录会让 pi-mcp/pi-coding-agent 等以第二副本
 * 身份被检出，MCP 整块不可用。junction 之后两侧 realpath 相同，
 * 且 update-sdk 升级 trace 副本时哈希入口自动跟随。
 * prepare-standalone 与 postinstall（npm pack 会把 junction 展开回
 * 实目录，装包时必须重连）共用。
 */
const EXTERNALS_MANIFEST = "standalone-externals.json";

/** 枚举 `.next/node_modules` 下的外部包条目（相对路径，如 "@scope/pkg-<hash>" / "pkg-<hash>"）。 */
function listExternalDirs(hashedRoot) {
  const out = [];
  if (!fs.existsSync(hashedRoot)) return out;
  for (const entry of fs.readdirSync(hashedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("@")) {
      for (const sub of fs.readdirSync(path.join(hashedRoot, entry.name))) {
        out.push(`${entry.name}/${sub}`);
      }
    } else {
      out.push(entry.name);
    }
  }
  return out;
}

/** 把外部包哈希目录清单写入 standalone 根（供 postinstall 重建 junction）。
 *  目录可能已被前一次打包删除——与已有 manifest 取并集，防止重复
 *  for-pack 组装把清单冲空。 */
function writeExternalsManifest(serverDir, { log = console.log } = {}) {
  const hashedRoot = path.join(serverDir, ".next", "node_modules");
  const manifestPath = path.join(serverDir, EXTERNALS_MANIFEST);
  const entries = new Set(listExternalDirs(hashedRoot));
  if (fs.existsSync(manifestPath)) {
    try {
      for (const e of JSON.parse(fs.readFileSync(manifestPath, "utf8"))) entries.add(e);
    } catch {
      // manifest 损坏则以现扫描为准
    }
  }
  const out = [...entries];
  fs.writeFileSync(manifestPath, JSON.stringify(out, null, 1));
  log(`  externals manifest: ${out.length} 项`);
}

function linkExternalsToTraced(serverDir, { log = console.log } = {}) {
  const hashedRoot = path.join(serverDir, ".next", "node_modules");
  const HASH_SUFFIX = /-[0-9a-f]{16}$/;
  const linkType = process.platform === "win32" ? "junction" : "dir";
  // 条目来源：优先 manifest（装包时目录可能整体不在 tarball 里），否则扫描现存目录。
  let rels;
  const manifestPath = path.join(serverDir, EXTERNALS_MANIFEST);
  if (fs.existsSync(manifestPath)) {
    try {
      rels = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      rels = [];
    }
  } else {
    rels = listExternalDirs(hashedRoot);
  }
  for (const rel of rels) {
    const base = rel.split("/").pop();
    const name = base.replace(HASH_SUFFIX, "");
    if (name === base) continue; // 非哈希目录，跳过
    const scope = rel.split("/")[0].startsWith("@") ? rel.split("/")[0] : null;
    const pkgName = scope ? `${scope}/${name}` : name;
    const traced = path.join(serverDir, "node_modules", ...pkgName.split("/"));
    if (!fs.existsSync(traced)) continue; // trace 缺副本时保留物化目录
    const target = path.join(hashedRoot, ...rel.split("/"));
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(traced, target, linkType);
    log(`  linked ${pkgName} -> node_modules`);
  }
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
    // prepare-standalone 起哈希入口改为 junction：指向 trace 副本，
    // 保持 SDK"同一副本"自检通过；旧物化目录也统一改链。
    fs.symlinkSync(fresh, dir, "junction");
    log(`  已刷新 ${name} 的链接`);
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

module.exports = { findStandaloneServer, rematerializeExternalLinks, linkExternalsToTraced, writeExternalsManifest };
