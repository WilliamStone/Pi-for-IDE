// VSCodium e2e helpers — playwright._electron drives the real app binary.
// No browser download: _electron speaks CDP to the launched app itself.
import { execFileSync } from "node:child_process";

/**
 * 宿主环境若设了 ELECTRON_RUN_AS_NODE=1，Electron exe 会以纯 Node 模式
 * 启动（不接 CLI 参数、不开 DevTools）——拉起前必须剥掉。
 */
export function cleanElectronEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * VSCodium 路径：环境变量 PI_E2E_VSCODIUM 优先；否则按平台惯例猜。
 * 返回 { exe, cli }——exe 是 electron.launch 目标；cli（bin/codium.cmd）
 * 用于安装扩展等 CLI 操作（Windows 下 VSCodium.exe 不吃 CLI 参数）。
 * 返回 null → 测试 skip（不是失败）。
 */
export function findVscodium() {
  const fromEnv = process.env.PI_E2E_VSCODIUM;
  const localAppData = process.env.LOCALAPPDATA;
  const candidates = [
    fromEnv,
    localAppData && path.join(localAppData, "Programs", "VSCodium", "VSCodium.exe"),
  ].filter(Boolean);
  const exe = candidates.find(existsSync);
  if (!exe) return null;
  const cli = path.join(path.dirname(exe), "bin", process.platform === "win32" ? "codium.cmd" : "codium");
  return { exe, cli: existsSync(cli) ? cli : exe };
}

/** vscode-extension 目录下最新的 pi-for-ide-*.vsix。 */
export function latestVsix(extDir) {
  const files = readdirSync(extDir)
    .filter((f) => /^pi-for-ide-\d+\.\d+\.\d+\.vsix$/.test(f))
    .map((f) => ({ f, m: statSync(path.join(extDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files[0] ? path.join(extDir, files[0].f) : null;
}

/**
 * 隔离 fixture：临时工作区 + 干净 user-data / extensions 目录。
 * 每 fixture 独占一个 39xxx 端口——attach 只扫 3030–3039，
 * 独占口保证测试间不共享 server（env/fixture 隔离才成立），
 * 也避免连上用户真身在跑的 3030 实例。
 */
export function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pi-e2e-"));
  const workspace = path.join(root, "ws");
  const port = 39000 + Math.floor(Math.random() * 900);
  const settingsDir = path.join(workspace, ".vscode");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(path.join(workspace, "hello.txt"), "hello e2e\n");
  writeFileSync(
    path.join(settingsDir, "settings.json"),
    JSON.stringify({ "Pi for IDE.autoStart": true, "Pi for IDE.port": port }, null, 2),
  );
  return {
    root,
    port,
    workspace,
    userDataDir: path.join(root, "user-data"),
    extensionsDir: path.join(root, "extensions"),
  };
}

/** 先把 vsix 装进隔离的 extensions dir（CLI 装完即退），再拉起 app。 */
export function installVsix(cli, vsix, { userDataDir, extensionsDir }) {
  const args = [
    "--user-data-dir", userDataDir,
    "--extensions-dir", extensionsDir,
    "--install-extension", vsix,
    "--force",
  ];
  const env = cleanElectronEnv();
  // .cmd 不能 execFileSync 直跑，走 cmd /c
  if (process.platform === "win32" && cli.endsWith(".cmd")) {
    execFileSync("cmd", ["/c", cli, ...args],
      { encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"], env });
  } else {
    execFileSync(cli, args,
      { encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"], env });
  }
}

/**
 * 轮询 app 的所有目标（windows + context pages），找满足谓词的 page。
 * webview 在 Electron 里是独立 WebContents——可能以 page 形式出现。
 */
export async function waitForTarget(app, describe, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = [];
  while (Date.now() < deadline) {
    const seen = new Set();
    lastSeen = [];
    for (const p of [...app.windows(), ...app.context().pages()]) {
      if (seen.has(p)) continue;
      seen.add(p);
      try {
        lastSeen.push(`${p.url()} | ${await p.title().catch(() => "?")}`);
        if (await predicate(p)) return p;
      } catch {
        // target 正在导航/销毁 — 下一轮再看
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for target: ${describe}; seen: ${lastSeen.join(" || ")}`);
}

/** 在 page/frame 的后代 frames 里等一个 url 满足谓词的 frame（OOPIF 含 iframe）。 */
export async function waitForFrame(pageOrFrame, urlPredicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frames = typeof pageOrFrame.frames === "function"
      ? pageOrFrame.frames()
      : pageOrFrame.childFrames();
    const hit = frames.find((f) => urlPredicate(f.url()));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("timed out waiting for frame");
}

import { homedir } from "node:os";

/** pi-web 在跑实例的 run-record 目录（~/.pi/agent/pi-web-run/<pid>.json） */
function runRecordDir() {
  const configured = process.env.PI_CODING_AGENT_DIR;
  const agentDir = configured && configured !== "~" ? configured : path.join(homedir(), ".pi", "agent");
  return path.join(agentDir, "pi-web-run");
}

/**
 * 现有 run-record 的 pid 集。attach 只认"已在跑的本系实例"——测试间
 * 残留的 spawn 会让下一个测试 attach 到错的环境（env/seed 全失效）。
 * 用法：launch 前 take snapshot，cleanup 时 killNewRunPids(before)。
 * 只清测试窗口内新增的 pid——用户真身实例的记录早于测试，不碰。
 */
export function snapshotRunPids() {
  try {
    return new Set(readdirSync(runRecordDir()).filter((f) => f.endsWith(".json")));
  } catch {
    return new Set();
  }
}

/** 沿父链上溯找 marker（e2e 的 --user-data-dir 路径）：server→shim→ext host
 *  的 cmdline 链中，只有 ext host 级带 user-data-dir，单层检查会漏。 */
function ancestryHasMarker(pid, marker, hops = 4) {
  if (process.platform !== "win32" || !marker) return true;
  let cur = pid;
  for (let i = 0; i < hops && cur > 0; i++) {
    try {
      const ppid = Number(execFileSync("powershell", ["-NoProfile", "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${cur}').ParentProcessId`],
        { encoding: "utf8", timeout: 8000 }).trim());
      if (!ppid) return false;
      const cmd = execFileSync("powershell", ["-NoProfile", "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${ppid}').CommandLine`],
        { encoding: "utf8", timeout: 8000 });
      if (cmd.includes(marker)) return true;
      cur = ppid;
    } catch { return false; }
  }
  return false;
}

/**
 * 定点清理 snapshot 之后新增的 run-record 进程。
 * 判别：只杀祖先链带本测试 user-data-dir 标记的实例——用户真身
 * VSCodium 并行 spawn 的 server 祖先指向 Roaming profile，跳过不碰。
 */
export function killNewRunPids(before, marker) {
  let names = [];
  try {
    names = readdirSync(runRecordDir()).filter((f) => f.endsWith(".json"));
  } catch { return; }
  for (const name of names) {
    if (before.has(name)) continue;
    let rec = {};
    try { rec = JSON.parse(readFileSync(path.join(runRecordDir(), name), "utf8")); } catch { /* 读不出也杀 pid 名 */ }
    for (const pid of [rec.pid, rec.nextPid, Number(name.replace(".json", ""))]) {
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      if (!ancestryHasMarker(pid, marker)) continue; // 非本测试实例
      try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 10000 }); } catch { /* 已退 */ }
    }
  }
}

/** 命令面板执行命令（F1 → 键入 → Enter）。 */
export async function runCommand(page, name) {
  await page.keyboard.press("F1");
  const box = page.locator(".quick-input-widget input");
  await box.waitFor({ state: "visible", timeout: 15000 });
  await box.fill(name);
  // 等候选渲染再回车
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
}

/**
 * 经 Explorer 打开文件再点编辑器标题栏的 Pi 导航图标——比命令面板
 * 确定性高（不依赖 palette 过滤时序）。fixtures 里须有该文件。
 */
export async function openPiPanelViaEditorTitle(page, fileName = "hello.txt") {
  // Explorer 里点开文件（资源管理器默认在侧栏）
  const row = page.locator(`.explorer-viewlet .monaco-list-row:has-text("${fileName}")`).first();
  await row.waitFor({ state: "visible", timeout: 30000 });
  await row.click();
  // 编辑器标题栏导航按钮：piIde.open（icon $(comment-discussion)，
  // aria-label 只有 title 部分 "Open"，不含 category）
  const btn = page.locator('.editor-actions .codicon-comment-discussion, .editor-actions [aria-label="Open"]').first();
  await btn.waitFor({ state: "visible", timeout: 30000 });
  await btn.click();
}
