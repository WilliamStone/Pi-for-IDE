"use strict";

// pnpm -g 升级/重装本包时，仍在跑的 server 会攥住旧安装目录里被硬链接
// 的文件，pnpm 删除旧目录即报 os error 32——原文毫无诊断。本脚本跑在
// pnpm 替换旧安装之前：检出在跑实例就用人话说明原因与停法并中止，
// 把"装到一半莫名失败"换成"先停再装"。
// 原则：fail-open——检查本身出任何错都放行，绝不让守门脚本搞挂安装。

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { fileURLToPath } = require("url");
const { isProcessAlive, readProcessCommand } = require("./run-records");

function getAgentDir() {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (!configured) return path.join(os.homedir(), ".pi", "agent");
  if (configured === "~") return os.homedir();
  if (configured.startsWith("~/") || configured.startsWith("~\\")) return path.join(os.homedir(), configured.slice(2));
  if (configured.startsWith("file://")) return fileURLToPath(configured);
  return configured;
}

// win32: image name 只够排除明显无关进程——VSCodium.exe-as-node 的
// server 得看完整命令行里有没有 pi-web/server.js 标记。
function isOurs(pid) {
  const image = readProcessCommand(pid);
  if (image === null) return true; // 读不到就当是（Windows 上多半是权限差异）
  if (/^node/i.test(image)) return true;
  if (process.platform !== "win32") return /pi-web|next-server/.test(image);
  // Windows: tasklist 只给 image name——对非 node 的进程再取一次完整 cmdline
  try {
    const out = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
      { encoding: "utf8", timeout: 8_000, windowsHide: true },
    );
    const cmdline = out.status === 0 ? out.stdout : "";
    return cmdline === "" ? true : /pi-web|server\.js/i.test(cmdline);
  } catch {
    return true;
  }
}

function liveInstances() {
  const dir = path.join(getAgentDir(), "pi-web-run");
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      for (const pid of [rec.pid, rec.nextPid].filter((p) => Number.isSafeInteger(p) && p > 0)) {
        if (isProcessAlive(pid) && isOurs(pid)) {
          found.push({ pid, url: rec.url || "?" });
          break;
        }
      }
    } catch { /* 单条坏记录不挡路 */ }
  }
  return found;
}

function main() {
  const running = liveInstances();
  if (!running.length) return;
  const list = running.map((r) => `  pid ${r.pid}  ${r.url}`).join("\n");
  const msg = [
    "",
    "pi-web-for-ide is currently RUNNING and holding this package's files:",
    list,
    "",
    "Upgrading/reinstalling now will fail partway (Windows: os error 32",
    '"file in use"). Stop it first, then retry the install:',
    "  pi-web-for-ide stop                       # CLI 记录到的实例",
    '  VS Code: "Pi for IDE: Stop Server"        # 扩展拉起的实例',
    "  or close the VSCodium/browser window using it.",
    "",
  ].join("\n");
  if (process.platform === "win32") {
    console.error(msg);
    process.exitCode = 1; // 中止安装：比 os error 32 早、且指得出路
  } else {
    console.warn(msg + "(continuing — only Windows locks in-use files)");
  }
}

try {
  main();
} catch { /* fail-open：守门自身出问题绝不挡安装 */ }
