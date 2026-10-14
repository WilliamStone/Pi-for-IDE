#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getUnsupportedNodeVersionMessage, isNodeVersionSupported } = require("./node-version");

if (!isNodeVersionSupported(process.versions.node)) {
  console.error(getUnsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn, spawnSync } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseLaunchOptions } = require("./pi-web-options");

const pkgDir = path.join(__dirname, "..");

// 子命令：pi-web update-sdk <version>
// 就地升级 pi SDK（@earendil-works/pi-*，四个包同版本 pin）。机制本身只是
// 在依赖目录里跑 npm install --save-exact；真正的成本是跨版本 API 适配——
// pi-web 代码按特定 SDK 版本编写，升级后请重启服务并回归验证。
// standalone 发行形态下依赖装在 standalone 应用目录内，且 .next/node_modules
// 下的 <pkg>-<hash> 目录是打包时固化的副本，装完后需要重新物化。
if (process.argv[2] === "update-sdk") {
  const version = process.argv[3];
  if (!version) {
    console.error("用法: pi-web update-sdk <version>，如 pi-web update-sdk 0.90.0");
    process.exit(1);
  }
  const sdkNames = [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
  ];
  const standaloneServerPath = findStandaloneServer(pkgDir);
  const targetDir = standaloneServerPath ? path.dirname(standaloneServerPath) : pkgDir;
  // standalone 形态只跑运行时，跳过 devDependencies 的拉取。
  const omitDev = standaloneServerPath ? ["--omit=dev"] : [];
  const result = spawnSync("npm", ["install", "--save-exact", "--no-audit", "--no-fund", ...omitDev, ...sdkNames.map((n) => `${n}@${version}`)], {
    cwd: targetDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error(`npm 启动失败: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (standaloneServerPath) {
    rematerializeExternalLinks(targetDir);
  }
  console.log(`pi SDK 已更新（${targetDir}）。跨版本升级可能需要 pi-web 侧适配——请重启服务并回归验证。`);
  process.exit(0);
}

const { port, hostname, openBrowser } = parseLaunchOptions();
const loopbackHostnames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const passwordEnabled = Boolean(process.env.PI_WEB_PASSWORD);

if (!loopbackHostnames.has(hostname)) {
  if (passwordEnabled) {
    console.warn(
      `Warning: pi-web is listening on ${hostname} with Basic Auth over HTTP. Use HTTPS or a trusted VPN to protect the password in transit.`,
    );
  } else {
    console.warn(
      `Warning: pi-web is listening on ${hostname} without authentication. Only use this on a trusted network.`,
    );
  }
}

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
function rematerializeExternalLinks(serverDir) {
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
    console.log(`  已刷新 ${name} 的固化副本`);
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

/** stdout 透传 + 首次 Ready 后自动开浏览器（受 --no-open 控制）。 */
function wireStdout(child, url) {
  let browserOpened = false;
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    if (openBrowser && !browserOpened && text.includes("Ready")) {
      browserOpened = true;
      const isWindows = process.platform === "win32";
      const isMac = process.platform === "darwin";
      const openCmd = isWindows ? "start" : isMac ? "open" : "xdg-open";
      const opener = spawn(openCmd, [url], {
        shell: isWindows,
        stdio: "ignore",
        detached: true,
      });
      opener.on("error", (error) => {
        console.warn(`Could not open browser automatically: ${error.message}`);
      });
      opener.unref();
    }
  });
}

const standaloneServer = findStandaloneServer(pkgDir);
const url = `http://${hostname}:${port}`;

if (standaloneServer) {
  // npm 发行形态：standalone server.js 只认 PORT/HOSTNAME 环境变量。
  const child = spawn(process.execPath, [standaloneServer], {
    cwd: path.dirname(standaloneServer),
    stdio: ["inherit", "pipe", "inherit"],
    env: { ...process.env, PORT: port, HOSTNAME: hostname },
  });
  wireStdout(child, url);
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  // 仓库开发形态：next start（需要 .next 构建产物 + 已安装依赖）。
  const nextDir = path.join(pkgDir, ".next");
  if (!fs.existsSync(nextDir)) {
    console.error("Build artifacts not found. Please report this issue.");
    process.exit(1);
  }

  // Resolve next's CLI entry directly to avoid relying on .bin symlinks (which
  // may not exist when installed via npx).
  let nextBin;
  try {
    nextBin = require.resolve("next/dist/bin/next", { paths: [pkgDir] });
  } catch {
    // Fallback: locate next package root and derive the bin path manually.
    try {
      const nextPkg = require.resolve("next/package.json", { paths: [pkgDir] });
      nextBin = path.join(path.dirname(nextPkg), "dist", "bin", "next");
    } catch {
      nextBin = path.join(pkgDir, "node_modules", "next", "dist", "bin", "next");
    }
  }

  // Always run next's JS entry with node directly — avoids .bin symlink issues
  // and path-with-spaces problems on Windows when shell: true is used.
  const child = spawn(process.execPath, [nextBin, "start", "-p", port, "-H", hostname], {
    cwd: pkgDir,
    stdio: ["inherit", "pipe", "inherit"],
    env: { ...process.env, PI_WEB_HOSTNAME: hostname },
  });
  wireStdout(child, url);
  child.on("exit", (code) => process.exit(code ?? 0));
}
