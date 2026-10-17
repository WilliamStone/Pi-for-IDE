"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { execFileSync, spawnSync } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");

const FETCH_TIMEOUT_MS = 10_000;

// 包名从 package.json 读——fork 发行包（如 pi-web-for-ide）与上游共用此逻辑。
function getPackageName(pkgDir = path.join(__dirname, "..")) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(path.join(pkgDir, "package.json")).name;
}

function npmLatestUrl(name) {
  return `https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`;
}

function manualCommand(name) {
  return `npm install -g ${name}@latest`;
}

// Port of lib/app-update.ts (bin cannot import TypeScript).
// 版本号形如 0.12.1 或 0.12.1-3（上游 base + 本仓迭代序号）。
function parseStableVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/.exec(version);
  if (!match) return null;
  const parts = match.slice(1).map((part) => (part === undefined ? null : Number(part)));
  if (!parts.slice(0, 3).every(Number.isSafeInteger)) return null;
  if (parts[3] !== null && !Number.isSafeInteger(parts[3])) return null;
  return parts;
}

function isNewerStableVersion(candidate, current) {
  const candidateParts = parseStableVersion(candidate);
  const currentParts = parseStableVersion(current);
  if (!candidateParts || !currentParts) return false;
  for (let index = 0; index < 3; index += 1) {
    if (candidateParts[index] !== currentParts[index]) {
      return candidateParts[index] > currentParts[index];
    }
  }
  // 同 base：正式版 > 序号版；同有序号时比序号。
  if (candidateParts[3] === null) return currentParts[3] !== null;
  if (currentParts[3] === null) return false;
  return candidateParts[3] > currentParts[3];
}

async function fetchLatestVersion(name) {
  const response = await fetch(npmLatestUrl(name), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
  const { version } = await response.json();
  if (typeof version !== "string" || !parseStableVersion(version)) {
    throw new Error("npm registry returned an invalid version");
  }
  return version;
}

// npm's own CLI script run through this node, so no shell is needed on
// Windows (same lookup as lib/node-cli.ts). null: no way to run npm safely.
function findNpmInvocation(args, nodeDir = path.dirname(process.execPath), platform = process.platform, exists = fs.existsSync) {
  for (const script of [
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ]) {
    if (exists(script)) return { command: process.execPath, args: [script, ...args] };
  }
  return platform === "win32" ? null : { command: "npm", args };
}

function realpathOrSelf(target, realpath = fs.realpathSync) {
  try {
    return realpath(target);
  } catch {
    return path.resolve(target);
  }
}

// "global": pkgDir is <npm root -g>/<name>（scoped 含一级 scope 目录）;
// "npx": an npx cache; else "other".
function getInstallKind({ name, pkgDir, npmRoot, realpath = fs.realpathSync }) {
  const realPkgDir = realpathOrSelf(pkgDir, realpath);
  if (realPkgDir.split(/[\\/]/).includes("_npx")) return "npx";
  if (!npmRoot) return "other";
  const expected = path.join(realpathOrSelf(npmRoot, realpath), ...name.split("/"));
  return realPkgDir === expected ? "global" : "other";
}

function getGlobalNpmRoot() {
  const invocation = findNpmInvocation(["root", "-g"]);
  if (!invocation) return null;
  try {
    return execFileSync(invocation.command, invocation.args, { encoding: "utf8", timeout: 30_000 }).trim();
  } catch {
    return null;
  }
}

function runNpmInstall(name, version) {
  const invocation = findNpmInvocation(["install", "-g", `${name}@${version}`]);
  if (!invocation) return null;
  const result = spawnSync(invocation.command, invocation.args, { stdio: "inherit" });
  return result.status ?? 1;
}

async function runUpdate({
  check,
  currentVersion,
  pkgDir,
  listRecords,
  formatRecord,
  name = getPackageName(pkgDir),
  fetchLatest = fetchLatestVersion,
  getNpmRoot = getGlobalNpmRoot,
  install = runNpmInstall,
  realpath = fs.realpathSync,
  log = console.log,
  error = console.error,
}) {
  let latest;
  try {
    latest = await fetchLatest(name);
  } catch (fetchError) {
    error(`Could not check for updates: ${fetchError.message}`);
    return 1;
  }
  if (!isNewerStableVersion(latest, currentVersion)) {
    log(`pi-web ${currentVersion} is up to date.`);
    return 0;
  }
  log(`pi-web ${latest} is available (installed: ${currentVersion}).`);
  if (check) return 0;

  // A running `next start` has .next/ open; never replace it underneath.
  const running = await listRecords();
  if (running.length > 0) {
    error(`pi-web is running:\n${running.map(formatRecord).join("\n")}\nRun \`pi-web-for-ide \` first, then update.`);
    return 1;
  }

  const kind = getInstallKind({ name, pkgDir, npmRoot: getNpmRoot(), realpath });
  if (kind === "npx") {
    error(`This pi-web runs from the npx cache. Run \`npx ${name}@latest\` instead.`);
    return 1;
  }
  if (kind !== "global") {
    error(`This pi-web is not a global npm install. Update it yourself, for example: ${manualCommand(name)}`);
    return 1;
  }

  const code = install(name, latest);
  if (code === null) {
    error(`Could not find npm. Run: ${manualCommand(name)}`);
    return 1;
  }
  return code;
}

module.exports = { findNpmInvocation, getInstallKind, isNewerStableVersion, runUpdate };
