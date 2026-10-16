#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getUnsupportedNodeVersionMessage, isNodeVersionSupported } = require("./node-version");

if (!isNodeVersionSupported(process.versions.node)) {
  console.error(getUnsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getHelpText, parseCommandLine } = require("./pi-web-options");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getNextNodeArgs } = require("./pi-web-node-args");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { wireChildProcessLifecycle } = require("./process-lifecycle");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { rotatePreviewSecrets, getRotationWarning } = require("./rotate-preview-secrets");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { openInBrowser } = require("./browser-opener");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRunRecordTracker, getOpenUrl, getRunDir } = require("./run-records");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getPackageVersion, runCommand } = require("./pi-web-commands");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { findStandaloneServer, linkExternalsToTraced } = require("./pi-web-standalone");

let launchOptions;
try {
  launchOptions = parseCommandLine();
} catch (error) {
  fs.writeSync(
    process.stderr.fd,
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}

if (launchOptions.help) {
  fs.writeSync(process.stdout.fd, getHelpText());
  process.exit(0);
}

if (launchOptions.command === "start") {
  startServer(launchOptions);
} else {
  runCommand(launchOptions).then(
    exitWhenIdle,
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      exitWhenIdle(1);
    },
  );
}

// Leave once the event loop drains instead of calling process.exit() right
// after a fetch(): on Windows, Node.js 23 up to 24.19 / 26.6 can then abort
// with a libuv assertion (UV_HANDLE_CLOSING, win/async.c) while background
// work from the fetch is still winding down (#1174, nodejs/node#56645). The
// unref'd timer only fires if something still holds the loop open.
function exitWhenIdle(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2_000).unref();
}

/**
 * 装包脚本未跑时补建 .next/node_modules/<pkg>-<hash> junction。
 * 快路径：清单内每条目都存在则零成本返回。
 */
function ensureExternalsLinked(serverDir) {
  const manifestPath = path.join(serverDir, "standalone-externals.json");
  if (!fs.existsSync(manifestPath)) return;
  let rels;
  try {
    rels = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return;
  }
  const hashedRoot = path.join(serverDir, ".next", "node_modules");
  const missing = rels.filter((rel) => !fs.existsSync(path.join(hashedRoot, ...rel.split("/"))));
  if (missing.length === 0) return;
  console.log(`pi-web: 补建 ${missing.length} 个外部包链接（postinstall 未执行）…`);
  linkExternalsToTraced(serverDir);
}

function startServer({ port, hostname, openBrowser }) {

  const pkgDir = path.join(__dirname, "..");
  // npm 发行包打的是 standalone 产物（自包含 node_modules）：优先直接跑
  // .next/standalone/**/server.js（PORT/HOSTNAME 走环境变量），仓库开发环境
  // 没有 standalone → 回退 next start。
  const standaloneServer = findStandaloneServer(pkgDir);
  const serverDir = standaloneServer ? path.dirname(standaloneServer) : pkgDir;

  // 装包脚本可能被 npm/pnpm 的脚本策略拦下（registry 全局安装时 pnpm 默认
  // 不跑 postinstall）→ .next/node_modules 的 junction 缺失会使外部包无法
  // 解析、MCP 自检失败。启动时自检并按清单补链，不依赖 postinstall。
  if (standaloneServer) ensureExternalsLinked(serverDir);
  const nextDir = path.join(serverDir, ".next");

  // Resolve next's CLI entry directly to avoid relying on .bin symlinks (which
  // may not exist when installed via npx).
  let nextBin;
  if (!standaloneServer) {
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
  }

  const loopbackHostnames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  const passwordEnabled = Boolean(process.env.PI_WEB_PASSWORD);

  if (!fs.existsSync(nextDir)) {
    console.error("Build artifacts not found. Please report this issue.");
    process.exit(1);
  }

  // Replace the published preview-mode secrets with fresh random values so the
  // previewModeId baked into the npm tarball cannot be used to skip the proxy
  // (via the x-prerender-revalidate header). Must happen before server start.
  const rotation = rotatePreviewSecrets(nextDir);
  if (!rotation.ok) {
    console.warn(getRotationWarning(rotation.reason));
  }

  if (!loopbackHostnames.has(hostname)) {
    if (passwordEnabled) {
      console.warn(
        `Warning: pi-web is listening on ${hostname} with password authentication over HTTP. Use HTTPS or a trusted VPN to protect the password in transit.`,
      );
    } else {
      console.warn(
        `Warning: pi-web is listening on ${hostname} without authentication. Only use this on a trusted network.`,
      );
    }
  }

  let child;
  if (standaloneServer) {
    // standalone server.js 只认 PORT/HOSTNAME 环境变量。
    child = spawn(process.execPath, [standaloneServer], {
      cwd: serverDir,
      stdio: ["inherit", "pipe", "inherit"],
      env: { ...process.env, PORT: port, HOSTNAME: hostname },
    });
  } else {
    const nextArgs = ["start", "-p", port];
    nextArgs.push("-H", hostname);

    // Always run next's JS entry with node directly — avoids .bin symlink issues
    // and path-with-spaces problems on Windows when shell: true is used.
    child = spawn(process.execPath, getNextNodeArgs(nextBin, nextArgs), {
      cwd: pkgDir,
      stdio: ["inherit", "pipe", "inherit"],
      env: { ...process.env, PI_WEB_HOSTNAME: hostname },
    });
  }
  wireChildProcessLifecycle(child);

  // Port 0 lets the OS pick a port we never learn, so such a server gets no record.
  const runRecord = createRunRecordTracker({
    dir: getRunDir,
    record: {
      pid: process.pid,
      nextPid: child.pid,
      port: Number(port),
      hostname,
      url: getOpenUrl(hostname, port),
      version: getPackageVersion(pkgDir),
      startedAt: new Date().toISOString(),
    },
  });

  let serverReady = false;
  const url = `http://${hostname}:${port}`;

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    if (!serverReady && text.includes("Ready")) {
      serverReady = true;
      if (port !== "0") runRecord.markReady();
      if (openBrowser) openInBrowser(url);
    }
  });
}
