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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, statSync } from "node:fs";
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

/** 隔离 fixture：临时工作区 + 干净 user-data / extensions 目录。 */
export function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pi-e2e-"));
  const workspace = path.join(root, "ws");
  const settingsDir = path.join(workspace, ".vscode");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(path.join(workspace, "hello.txt"), "hello e2e\n");
  writeFileSync(
    path.join(settingsDir, "settings.json"),
    JSON.stringify({ "Pi for IDE.autoStart": true }, null, 2),
  );
  return {
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
