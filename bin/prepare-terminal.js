// node-pty 1.1.0 ships macOS spawn-helper binaries without executable bits.
// Remove this workaround once the upstream package preserves those modes.
/* eslint-disable @typescript-eslint/no-require-imports */
const { chmodSync, statSync } = require("node:fs");
const { dirname, join } = require("node:path");

if (process.platform === "darwin") {
  const root = dirname(require.resolve("node-pty/package.json"));
  for (const directory of ["build/Release", "build/Debug", `prebuilds/darwin-${process.arch}`]) {
    const helper = join(root, directory, "spawn-helper");
    const stat = statSync(helper, { throwIfNoEntry: false });
    if (stat?.isFile() && (stat.mode & 0o111) !== 0o111) chmodSync(helper, stat.mode | 0o111);
  }
}

// npm pack 会把 standalone 里的 junction/symlink 展开成实目录，装包后
// 重连 .next/node_modules/<pkg>-<hash> -> node_modules/<pkg>，否则
// pi-sdk 双副本自检失败、MCP 不可用。
try {
  const { findStandaloneServer, linkExternalsToTraced } = require("./pi-web-standalone");
  const { join: joinPath, dirname: dirn } = require("node:path");
  const server = findStandaloneServer(joinPath(__dirname, ".."));
  if (server) linkExternalsToTraced(dirn(server), { log: (m) => console.log(`postinstall:${m}`) });
} catch {
  // 非 standalone 形态（如源码装包）忽略
}
