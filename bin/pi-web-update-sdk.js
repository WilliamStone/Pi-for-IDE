"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawnSync } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { findNpmInvocation } = require("./pi-web-update");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { findStandaloneServer, rematerializeExternalLinks } = require("./pi-web-standalone");

const SDK_PACKAGES = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
];

/**
 * pi-web update-sdk <version>：就地升级 pi SDK（@earendil-works/pi-* 同版本 pin）。
 * 机制本身只是在依赖目录里 npm install --save-exact；真正的成本是跨版本 API
 * 适配——pi-web 代码按特定 SDK 版本编写，升级后请重启服务并回归验证。
 *
 * standalone 发行形态下依赖装在 standalone 应用目录内（--omit=dev 跳过
 * devDependencies），且 .next/node_modules 下的 <pkg>-<hash> 目录是打包时
 * 固化的副本，装完后需要重新物化。
 */
function runUpdateSdk(version, {
  pkgDir = path.join(__dirname, ".."),
  log = console.log,
  error = console.error,
} = {}) {
  if (!version) {
    error("用法: pi-web update-sdk <version>，如 pi-web update-sdk 1.3.0");
    return 1;
  }
  const standaloneServerPath = findStandaloneServer(pkgDir);
  const targetDir = standaloneServerPath ? path.dirname(standaloneServerPath) : pkgDir;
  // standalone 形态只跑运行时，跳过 devDependencies 的拉取。
  const omitDev = standaloneServerPath ? ["--omit=dev"] : [];
  const args = ["install", "--save-exact", "--no-audit", "--no-fund", ...omitDev, ...SDK_PACKAGES.map((n) => `${n}@${version}`)];
  const invocation = findNpmInvocation(args, path.dirname(process.execPath), process.platform);
  if (!invocation) {
    error("找不到 npm，请手动在 " + targetDir + " 下执行: npm " + args.join(" "));
    return 1;
  }
  log(`在 ${targetDir} 内升级 pi SDK → ${version}`);
  const result = spawnSync(invocation.command, invocation.args, { cwd: targetDir, stdio: "inherit" });
  if (result.error) {
    error(`npm 启动失败: ${result.error.message}`);
    return 1;
  }
  if (result.status !== 0) return result.status ?? 1;
  if (standaloneServerPath) rematerializeExternalLinks(targetDir, { log });
  log("pi SDK 已更新。跨版本升级可能需要 pi-web 侧适配——请重启服务并回归验证。");
  return 0;
}

module.exports = { runUpdateSdk };
