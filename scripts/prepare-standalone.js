#!/usr/bin/env node
/**
 * 构建 pi-web standalone 产物并组装成自包含可运行目录。
 *
 * 流程：
 *   1. `PI_WEB_STANDALONE=1 npm run build` → 产出 `.next/standalone/`
 *   2. 定位 standalone 应用目录（`.next/standalone/<...>/server.js` 所在，
 *      嵌套深度随构建目录而变）
 *   3. 复制 `.next/static` → `<app>/.next/static`、`public` → `<app>/public`
 *      （standalone 不自动带静态资源，Next 文档要求手动复制）
 *   4. 补齐 @earendil-works 运行时资源（export-html 动态加载等 trace 漏网）
 *   5. 末行打印 `STANDALONE_DIR=<abs>` 供调用方解析
 *
 * npm 发布包（`prepack`）与 vscode-extension 打包共用本脚本；产物目录
 * 自带全部 node_modules（trace 实文件，无符号链接），不依赖 npm 安装依赖。
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cp = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");

function run(cmd, args, opts) {
  console.log(`\n▶ ${cmd} ${args.join(" ")}`);
  cp.execFileSync(cmd, args, { stdio: "inherit", cwd: repoRoot, shell: process.platform === "win32", ...opts });
}

function cpR(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // standalone 下 .next/node_modules/ 的哈希名是符号链接；
  // dereference 复制底层真实文件，避免打包时丢链接。
  fs.cpSync(src, dest, { recursive: true, dereference: true });
}

function findFile(root, name) {
  // 广度优先找第一个匹配文件。
  const queue = [root];
  while (queue.length) {
    const cur = queue.shift();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.name === name) {
        return full;
      }
    }
  }
  return undefined;
}

/**
 * 把 @earendil-works 下各包 dist 里运行时需要的资源文件
 * (.json/.png/.html/.css) 从源 node_modules 复制到 standalone node_modules，
 * 覆盖 Next trace 遗漏。不复制 .js (已被 trace 带上) 和 .map/.ts (开发期产物)。
 *
 * 例外：export-html/ 下的 .js（index.js / tool-renderer.js /
 * ansi-to-html.js）以及 vendor/*.min.js、template.js。
 * 这些 .js 通过 `await import(fileUrl)` 或 readFileSync 动态加载，
 * Next.js trace 追不到，standalone 里会缺失导致运行时 ENOENT。
 */
function copyRuntimeAssets(srcRoot, destRoot) {
  const pkgRoot = path.join(srcRoot, "node_modules", "@earendil-works");
  const destPkgRoot = path.join(destRoot, "node_modules", "@earendil-works");
  if (!fs.existsSync(pkgRoot)) return;
  for (const pkg of fs.readdirSync(pkgRoot)) {
    const srcDist = path.join(pkgRoot, pkg, "dist");
    const destDist = path.join(destPkgRoot, pkg, "dist");
    if (!fs.existsSync(srcDist) || !fs.existsSync(destDist)) continue;
    let copied = 0;
    for (const file of walkFiles(srcDist)) {
      const ext = path.extname(file);
      const rel = path.relative(srcDist, file);
      const isExportHtmlJs =
        ext === ".js" && rel.split(path.sep).includes("export-html");
      if (![".json", ".png", ".html", ".css"].includes(ext) && !isExportHtmlJs)
        continue;
      const dest = path.join(destDist, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file, dest);
      copied++;
    }
    if (copied > 0) console.log(`  ${pkg}: 补 ${copied} 个资源文件`);
  }
}

function walkFiles(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** 定位 standalone 应用目录（server.js 所在）。 */
function locateStandaloneAppDir() {
  const standaloneRoot = path.join(repoRoot, ".next", "standalone");
  if (!fs.existsSync(standaloneRoot)) {
    throw new Error("未找到 .next/standalone，next build 可能失败或未开启 standalone 模式");
  }
  const serverJs = findFile(standaloneRoot, "server.js");
  if (!serverJs) throw new Error("未在 standalone 中找到 server.js");
  return path.dirname(serverJs);
}

/**
 * 把 standalone `<app>/.next/node_modules/` 下 Turbopack 为
 * serverExternalPackages 生成的 <pkg>-<hash> 符号链接替换为真实文件副本——
 * npm pack 不保符号链接（且链接目标是构建机绝对路径），发行包里会断链。
 */
function materializeExternalLinks(serverDir) {
  const nm = path.join(serverDir, ".next", "node_modules");
  if (!fs.existsSync(nm)) return;
  const links = [];
  const collect = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) links.push(full);
      else if (e.isDirectory() && e.name.startsWith("@")) collect(full);
    }
  };
  collect(nm);
  for (const link of links) {
    const target = fs.realpathSync(link);
    fs.unlinkSync(link);
    fs.cpSync(target, link, { recursive: true, dereference: true });
    console.log(`  materialized ${path.basename(link)}`);
  }
}

/**
 * 只组装（不构建）：把静态资源与运行时资源补进已存在的 standalone 产物。
 * 返回 standalone 应用目录绝对路径。
 */
function assembleStandalone() {
  const serverDir = locateStandaloneAppDir();
  console.log(`standalone 服务器目录: ${path.relative(repoRoot, serverDir)}`);

  // 复制 .next/static（standalone 不含）
  const staticSrc = path.join(repoRoot, ".next", "static");
  if (fs.existsSync(staticSrc)) {
    cpR(staticSrc, path.join(serverDir, ".next", "static"));
  }
  // 复制 public（manifest/icons/sw.js 等）
  const publicSrc = path.join(repoRoot, "public");
  if (fs.existsSync(publicSrc)) {
    cpR(publicSrc, path.join(serverDir, "public"));
  }
  copyRuntimeAssets(repoRoot, serverDir);
  materializeExternalLinks(serverDir);
  return serverDir;
}

function main() {
  const noBuild = process.argv.includes("--no-build") || process.env.PI_WEB_SKIP_BUILD === "1";

  if (!noBuild) {
    // 1. build（standalone 由 next.config.ts 依 PI_WEB_STANDALONE 条件产出）
    console.log("=== 1/2 构建 pi-web（standalone）===");
    run("npm", ["run", "build"], {
      env: { ...process.env, TURBOPACK: "", PI_WEB_STANDALONE: "1" },
    });
  }

  // 2. 组装
  console.log("=== 2/2 组装 standalone 产物 ===");
  const serverDir = assembleStandalone();

  console.log(`\nSTANDALONE_DIR=${serverDir}`);
}

if (require.main === module) main();

module.exports = { assembleStandalone, locateStandaloneAppDir };
