import test from "node:test";
import { _electron as electron } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanElectronEnv, findVscodium, installVsix, killNewRunPids, latestVsix, makeFixture,
  openPiPanelViaEditorTitle, snapshotRunPids, waitForFrame,
} from "./helpers.mjs";
import { seedSession } from "./session-fixture.mjs";

/**
 * 真机 UI e2e：拉起干净 profile 的 VSCodium（只装我们的 vsix），
 * 打开临时工作区，跑 `Pi for IDE: Open`，等 webview target 出现，
 * 断言 shell→iframe 链路走到 pi-web 真页面，以及文件审查卡的
 * 宿主联动（diff / open / 漂移降级通知）。
 *
 * 覆盖的手工冒烟项：冷启动开面板不卡「加载中」、shell 状态机、
 * iframe 到 pi-web 的可达性、edit 双侧 diff、write/直接打开、
 * 漂移文件的 recorded-patch 降级 + 警告。不覆盖：真正发 prompt
 * （不动真配置/不烧 token——B 段靠 session-fixture 预置会话）。
 *
 * 入口：npm run test:e2e（不进日常门禁——需要真显示器）。
 * 慢路径（watchdog 自退 ~90s+）由 PI_E2E_SLOW=1 显式开启。
 */

const extDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function prerequisites(t) {
  const vscodium = findVscodium();
  if (!vscodium) {
    t.skip("no VSCodium found (set PI_E2E_VSCODIUM)");
    return null;
  }
  const vsix = latestVsix(extDir);
  if (!vsix) {
    t.skip("no pi-for-ide vsix — run npm run package first");
    return null;
  }
  return { ...vscodium, vsix };
}

/** 装扩展 + 拉起 app + 穿透三层 OOPIF 到 pi-web 页面 frame。 */
async function reachPiFrame({ exe, cli, vsix }, fixture, extraEnv = {}) {
  installVsix(cli, vsix, fixture);
  const app = await electron.launch({
    executablePath: exe,
    env: { ...cleanElectronEnv(), ...extraEnv },
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
  const win = await app.firstWindow();
  await win.waitForSelector(".monaco-workbench", { timeout: 60000 });
  await openPiPanelViaEditorTitle(win);
  await win.waitForSelector("iframe.webview", { state: "attached", timeout: 60000 });
  // index.html（vscode 宿主壳）→ fake.html（我们的 shell）→ pi-web
  const webviewHost = await waitForFrame(win, (u) => /vscode-webview:\/\//i.test(u), 60000);
  const shellFrame = await waitForFrame(webviewHost, (u) => /fake\.html/i.test(u), 60000);
  const piFrame = await waitForFrame(
    shellFrame,
    (u) => /^http:\/\/127\.0\.0\.1:\d+\//.test(u),
    120000, // 首次 standalone JIT 编译可能 30s+
  );
  return { app, win, piFrame };
}

test("VSCodium: panel opens and iframe reaches pi-web", { timeout: 300_000 }, async (t) => {
  const ctx = prerequisites(t);
  if (!ctx) return;
  const fixture = makeFixture();
  const { app, piFrame } = await reachPiFrame(ctx, fixture);
  try {
    // iframe 里是 pi-web 真页面——聊天输入框落地即通过
    await piFrame.waitForSelector("textarea", { timeout: 60000 });
  } finally {
    await app.close().catch(() => {});
    // 拉起的 pi-web 由 watchdog 在窗口关闭后 ~90s 内自退，无需手动清。
  }
});

test("VSCodium B: file-review actions drive host diff/open/patch-fallback", { timeout: 300_000 }, async (t) => {
  const ctx = prerequisites(t);
  if (!ctx) return;
  const fixture = makeFixture();
  // 独立 agent 目录预置一份 write+edit+drifted-edit 会话——不用真跑模型
  const seed = seedSession(fixture.root, fixture.workspace);
  // attach 会接住任一在跑的 pi-web——上个测试的 spawn 可能还活着，
  // 记录 pid 快照，结束后按 PID 定点清掉本测试新增的实例
  const before = snapshotRunPids();
  const { app, win, piFrame } = await reachPiFrame(ctx, fixture, {
    PI_CODING_AGENT_DIR: seed.agentDir,
  });
  try {
    await piFrame.waitForSelector("textarea", { timeout: 60000 });

    // 会话树点击受遮挡/可点击性影响大——直接跳 ?session=<id>，更稳。
    // 先等列表渲完再跳（SPA 过早赋 search 可能整页 reload 后仍落列表）；
    // 必须追加而不是替换：embed=vscode 参数丢了页面会退出 embed 态。
    // cwd 参数优先于 session（getInitialNavigation）——URL 直跳带 cwd 时
    // session 被忽略。必须走 SPA 内部导航：点会话树条目。
    const entry = piFrame.locator('a.session-tree-main:has-text("e2e seed turn")').first();
    await entry.waitFor({ timeout: 60000 });
    await entry.scrollIntoViewIfNeeded().catch(() => {});
    try {
      await entry.click({ timeout: 8000 });
    } catch {
      await entry.dispatchEvent("click"); // 遮挡时直发事件
    }
    await piFrame.waitForSelector("text=File review", { timeout: 60000 });

    // FileReviewCard 行：<button title="{path}">，行内动作 span role=button。
    // 同名文件还有 TurnWrittenFiles 芯片（无动作 span）——用 :has 锁定卡片行。
    const row = (name) => piFrame.locator(`button[title*="${name}"]:has(span[title])`).first();
    try {
      await row("edited.txt").waitFor({ timeout: 30000 });
    } catch (e) {
      const dump = await piFrame.evaluate(() => ({
        url: location.href.slice(0, 200),
        text: document.body?.innerText?.slice(-1500),
      })).catch((err) => String(err));
      console.log("pi-frame on row-timeout:", JSON.stringify(dump, null, 2));
      throw e;
    }

    // 动作 span 是 <button> 里嵌套的 10px 级元素——actionability 的
    // stable 检测常超时；这些点击的目标是桥请求，dispatchEvent 足够。
    const act = (name, title) =>
      row(name).locator(`span[title="${title}"]`).dispatchEvent("click");

    // B4 edit ↗ → 宿主开 vscode.diff（before 反放可重建 → 双侧编辑器）
    await act("edited.txt", "Open diff in editor");
    await win.waitForSelector(".monaco-diff-editor", { timeout: 60000 });

    // B8 write → → 宿主直接开文件（不开 diff），tab 出现文件名
    await act("written.txt", "Open file in editor");
    await win.waitForSelector('.tabs-container .tab:has-text("written.txt"), .monaco-icon-label:has-text("written.txt")', { timeout: 60000 });

    // B5 drifted ↗ → before 不可重建 → recorded patch 降级 + 警告通知
    await act("drifted.txt", "Open diff in editor");
    await win.waitForSelector(
      '.notification-toast:has-text("recorded patch"), .notification-toast:has-text("changed after this turn")',
      { timeout: 60000 },
    );
  } finally {
    await app.close().catch(() => {});
    killNewRunPids(before, fixture.userDataDir);
  }
});

// D 段（watchdog 自退）：关窗后心跳停，~autoStopAfterSec(90s 起)+余量内
// 端口必须释放。慢路径默认不跑，PI_E2E_SLOW=1 显式开。
test("VSCodium D: spawned server self-stops after window closes", { timeout: 300_000 }, async (t) => {
  if (process.env.PI_E2E_SLOW !== "1") {
    t.skip("set PI_E2E_SLOW=1 to run the ~2min watchdog test");
    return;
  }
  const ctx = prerequisites(t);
  if (!ctx) return;
  const fixture = makeFixture();
  const { app, piFrame } = await reachPiFrame(ctx, fixture);
  const url = new URL(piFrame.url());
  const port = url.port;
  await app.close().catch(() => {});
  // watchdog 间隔 + autoStopAfterSec(90) + 关阀余量——最多 180s
  const deadline = Date.now() + 180_000;
  let alive = true;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/embed`, { signal: AbortSignal.timeout(2000) });
      await res.arrayBuffer().catch(() => {});
      await new Promise((r) => setTimeout(r, 5000));
    } catch {
      alive = false;
      break;
    }
  }
  if (alive) throw new Error(`server on :${port} still answering after window closed + 180s`);
});
