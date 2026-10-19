import test from "node:test";
import { _electron as electron } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanElectronEnv, findVscodium, installVsix, latestVsix, makeFixture,
  openPiPanelViaEditorTitle, waitForFrame,
} from "./helpers.mjs";

/**
 * 真机 UI e2e：拉起干净 profile 的 VSCodium（只装我们的 vsix），
 * 打开临时工作区，跑 `Pi for IDE: Open`，等 webview target 出现，
 * 断言 shell→iframe 链路走到 pi-web 真页面。
 *
 * 覆盖的手工冒烟项：冷启动开面板不卡「加载中」、shell 状态机、
 * iframe 到 pi-web 的可达性。不覆盖：真正发 prompt（不动真配置/
 * 不烧 token）。
 *
 * 入口：npm run test:e2e（不进日常门禁——需要真显示器）。
 */

const extDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

test("VSCodium: panel opens and iframe reaches pi-web", { timeout: 300_000 }, async (t) => {
  const vscodium = findVscodium();
  if (!vscodium) {
    t.skip("no VSCodium found (set PI_E2E_VSCODIUM)");
    return;
  }
  const { exe, cli } = vscodium;
  const vsix = latestVsix(extDir);
  if (!vsix) {
    t.skip("no pi-for-ide vsix — run npm run package first");
    return;
  }
  const fixture = makeFixture();

  // 1) 装扩展到隔离 extensions dir（同步 CLI，装完退出）
  installVsix(cli, vsix, fixture);

  // 2) 拉起 app —— 干净 profile + 隔离扩展目录 + fixture 工作区
  const app = await electron.launch({
    executablePath: exe,
    env: cleanElectronEnv(),
    args: [
      "--user-data-dir", fixture.userDataDir,
      "--extensions-dir", fixture.extensionsDir,
      // 干净 profile 首开会弹 Workspace Trust → 受限模式下扩展不激活
      "--disable-workspace-trust",
      "--skip-welcome", "--skip-release-notes",
      "--no-sandbox", "--disable-gpu-sandbox",
      fixture.workspace,
    ],
    timeout: 60000,
  });
  try {
    // 3) 等 workbench 主窗口
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    // 工作台就绪：.monaco-workbench 出现
    await win.waitForSelector(".monaco-workbench", { timeout: 60000 });

    // 4) 打开面板：Explorer 点 fixture 文件 → 编辑器标题栏的 Pi 图标
    await openPiPanelViaEditorTitle(win);

    // 5) 面板创建 → workbench DOM 出现 iframe.webview；OOPIF 三层：
    //    index.html（vscode webview 宿主壳）→ fake.html（我们的 shell）
    //    → pi-web iframe。playwright page.frames()/frame.childFrames()
    //    能穿透 OOPIF，不需要独立 page target。
    await win.waitForSelector("iframe.webview", { state: "attached", timeout: 60000 });
    const webviewHost = await waitForFrame(
      win,
      (url) => /vscode-webview:\/\//i.test(url),
      60000,
    );
    const shellFrame = await waitForFrame(
      webviewHost,
      (url) => /fake\.html/i.test(url),
      60000,
    );

    // 6) shell → iframe.src 指向 pi-web 端口（postMessage 链路活了）
    const frame = await waitForFrame(
      shellFrame,
      (url) => /^http:\/\/127\.0\.0\.1:\d+\//.test(url),
      120000, // 首次 standalone JIT 编译可能 30s+
    );

    // 7) iframe 里是 pi-web 真页面——聊天输入框落地即通过
    await frame.waitForSelector("textarea", { timeout: 60000 });
  } finally {
    await app.close().catch(() => {});
    // 拉起的 pi-web 由 watchdog 在窗口关闭后 ~90s 内自退，无需手动清。
  }
});
