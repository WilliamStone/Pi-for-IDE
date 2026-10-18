#!/usr/bin/env node
/**
 * next build 包装器（跨平台）。
 *
 * 两个 Windows 构建地雷，都源于 @vercel/nft 对 fs 调用参数的静态求值：
 *   1. HOME/USERPROFILE 字面量 → 把整个用户主目录纳入追踪集（在装了模型/
 *      大目录的机器上是数 GB 引用 → 堆 OOM，构建耗时 7-10 分钟）；
 *   2. TEMP/TMP 同理 → 扫到 %TEMP% 里驱动拒答的文件（崩溃转储等）→
 *      readlink EPERM 直接炸。
 * 进程启动前把这些 env 指到仓库内空目录，追踪扫空即收；只影响构建期，
 * 产物代码运行时仍用系统真实路径。
 * 另：webpack 构建此项目需 >8GB 堆，直接给 16GB。
 */
const { mkdirSync } = require("fs");
const { join, resolve } = require("path");
const { execFileSync } = require("child_process");

const repoRoot = resolve(__dirname, "..");
const buildTmp = join(repoRoot, ".build-tmp");
mkdirSync(buildTmp, { recursive: true });
for (const key of ["TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"]) {
  process.env[key] = buildTmp;
}

execFileSync(
  process.execPath,
  ["--max-old-space-size=16384", require.resolve("next/dist/bin/next"), "build", "--webpack"],
  { stdio: "inherit", cwd: repoRoot },
);
