#!/usr/bin/env node
/**
 * 把 pi-web 的 `next build` 产物打包进 VSCode 扩展目录。
 *
 * 流程：
 *   1. 在仓库根目录跑 `next build`（standalone 模式）。
 *   2. 把 `.next/standalone/.../pi-code` 整体复制到
 *      `vscode-extension/resources/pi-web/`。
 *   3. 把 `.next/static` 复制到 `resources/pi-web/.next/static`
 *      （standalone 不含 static，Next 文档要求手动复制）。
 *
 * 之后 `vsce package` 会把 `resources/pi-web/` 一起打进 `.vsix`，用户安装
 * 扩展即用，无需全局安装 pi-web。
 */
const cp = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..", "..");
const extRoot = path.join(repoRoot, "vscode-extension");
const targetDir = path.join(extRoot, "resources", "pi-web");

function run(cmd, args, opts) {
  console.log(`\n▶ ${cmd} ${args.join(" ")}`);
  cp.execFileSync(cmd, args, { stdio: "inherit", cwd: repoRoot, ...opts });
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function cpR(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function main() {
  // 0. build 前先移走旧产物，避免 Next 把 vscode-extension/resources/pi-web
  // 下的源码副本当成项目文件编译（会导致 declare global 变量重复声明、
  // 类型冲突 build 失败）。
  const stashed = targetDir + ".__stash__";
  if (fs.existsSync(stashed)) rmrf(stashed);
  if (fs.existsSync(targetDir)) fs.renameSync(targetDir, stashed);
  try {
    // 1. build
    console.log("=== 1/3 构建 pi-web（standalone）===");
    // 显式清掉 TURBOPACK，避免与 next.config 的 webpack 模式冲突。
    run("npm", ["run", "build"], { env: { ...process.env, TURBOPACK: "" } });

    // 2. 定位 standalone 产物
    const standaloneRoot = path.join(repoRoot, ".next", "standalone");
    if (!fs.existsSync(standaloneRoot)) {
      throw new Error("未找到 .next/standalone，next build 可能失败或未开启 standalone 模式");
    }
    // standalone 嵌在 .next/standalone/<...>/pi-code，深度随 monorepo 而变，
    // 用 find 兜底。
    const serverJs = findFile(standaloneRoot, "server.js");
    if (!serverJs) throw new Error("未在 standalone 中找到 server.js");
    const serverDir = path.dirname(serverJs);
    console.log(`standalone 服务器目录: ${path.relative(repoRoot, serverDir)}`);

    // 3. 复制 standalone 产物
    console.log("=== 2/3 复制 standalone 产物到扩展目录 ===");
    rmrf(targetDir);
    fs.mkdirSync(targetDir, { recursive: true });
    cpR(serverDir, targetDir);

    // 4. 复制 .next/static（standalone 不含）
    console.log("=== 3/3 复制 .next/static ===");
    const staticSrc = path.join(repoRoot, ".next", "static");
    const staticDest = path.join(targetDir, ".next", "static");
    if (fs.existsSync(staticSrc)) {
      cpR(staticSrc, staticDest);
    }

    // 5. 补齐 pi-coding-agent / pi-ai 等运行时资源文件。
    console.log("=== 补齐 @earendil-works 运行时资源 ===");
    copyRuntimeAssets(repoRoot, targetDir);

    console.log(`\n✓ 完成。${path.relative(repoRoot, targetDir)} 大小: ${du(targetDir)}`);
  } finally {
    // 无论 build 成功失败都清理 stash（旧产物已被新 build 覆盖，stash 不再需要）
    if (fs.existsSync(stashed)) rmrf(stashed);
  }
}

/**
 * 把 @earendil-works 下各包 dist 里运行时需要的资源文件
 * (.json/.png/.html/.css) 从源 node_modules 复制到 standalone node_modules，
 * 覆盖 Next trace 遗漏。不复制 .js (已被 trace 带上) 和 .map/.ts (开发期产物)。
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
      // 只复制运行时资源；.js 已被 Next trace 带上，.map/.ts 是开发期产物
      // （源码映射/类型声明），运行时不需要，跳过以减小体积。
      //
      // 例外：export-html/ 下的 .js（index.js / tool-renderer.js /
      // ansi-to-html.js）以及 vendor/*.min.js、template.js。
      // 这些 .js 通过 `await import(fileUrl)` 或 readFileSync 动态加载，
      // Next.js trace 追不到，standalone 里会缺失导致运行时 ENOENT。
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

main();
