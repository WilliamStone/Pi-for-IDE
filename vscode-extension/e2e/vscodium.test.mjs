import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { _electron as electron } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanElectronEnv, extensionHostStartCount, findVscodium, guardAttachRange,
  installVsix, latestVsix, makeFixture, openPiPanelViaEditorTitle,
  releaseAttachGuard, reloadWindow, runCommand, waitForFrame,
  waitForNewExtensionHost,
} from "./helpers.mjs";
import { seedAgentConfig, seedSession } from "./session-fixture.mjs";

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

/**
 * 覆盖度账本：每段登记 verified/skipped+原因，尾部汇总测试点名——
 * "全绿"不该掩盖没验到的段（guard skip/模型不可用都是合理跳过，
 * 但必须让看结果的人一眼知道哪段没被验证）。
 */
const coverage = [];
function markCover(seg, status, note = "") {
  const rec = coverage.find((c) => c.seg === seg);
  if (rec) {
    rec.status = status;
    if (note) rec.note = note;
  } else {
    coverage.push({ seg, status, note });
  }
}
function coverSkip(t, seg, note) {
  markCover(seg, "skipped", note);
  t.skip(note);
}

function prerequisites(t, seg) {
  const vscodium = findVscodium();
  if (!vscodium) {
    coverSkip(t, seg, "no VSCodium found (set PI_E2E_VSCODIUM)");
    return null;
  }
  const vsix = latestVsix(extDir);
  if (!vsix) {
    coverSkip(t, seg, "no pi-for-ide vsix — run npm run package first");
    return null;
  }
  return { ...vscodium, vsix };
}

/** 装扩展 + 拉起 app + 穿透三层 OOPIF 到 pi-web 页面 frame。 */
async function reachPiFrame({ exe, cli, vsix }, fixture, extraEnv = {}) {
  installVsix(cli, vsix, fixture);
  const app = await electron.launch({
    executablePath: exe,
    env: { ...cleanElectronEnv(), PI_IDE_ATTACH_RANGE: `${fixture.port}-${fixture.port + 9}`, ...extraEnv },
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
  markCover("A panel-open", "ran");
  const ctx = prerequisites(t, "A panel-open");
  if (!ctx) return;
  const fixture = makeFixture();
  // attach-first 隔离：占住 303x 空口；真身实例在跑则 skip（不打扰/不污染）
  const guard = await guardAttachRange(fixture.port, fixture.port + 9);
  if (guard.oursPort) {
    releaseAttachGuard(guard);
    coverSkip(t, "A panel-open", `real pi-web instance on :${guard.oursPort}`);
    return;
  }
  const { app, piFrame } = await reachPiFrame(ctx, fixture);
  try {
    // iframe 里是 pi-web 真页面——聊天输入框落地即通过
    await piFrame.waitForSelector("textarea", { timeout: 60000 });
    markCover("A panel-open", "verified");
  } finally {
    await app.close().catch(() => {});
    releaseAttachGuard(guard);
    // 拉起的 pi-web 由 watchdog 在窗口关闭后 ~90s 内自退，无需手动清。
  }
});

test("VSCodium B: file-review actions drive host diff/open/patch-fallback", { timeout: 300_000 }, async (t) => {
  markCover("B file-review", "ran");
  const ctx = prerequisites(t, "B file-review");
  if (!ctx) return;
  const fixture = makeFixture();
  // 独立 agent 目录预置一份 write+edit+drifted-edit 会话——不用真跑模型
  const seed = seedSession(fixture.root, fixture.workspace);
  const guard = await guardAttachRange(fixture.port, fixture.port + 9);
  if (guard.oursPort) {
    releaseAttachGuard(guard);
    coverSkip(t, "B file-review", `real pi-web instance on :${guard.oursPort}`);
    return;
  }
  // 本测试 spawn 的实例在 fixture agentDir 下落 run-record——快照默认读
  // 真目录记不到它；清理由 watchdog/attach-guard 负责，无残留风险
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
    try {
      await entry.waitFor({ timeout: 60000 });
    } catch (e) {
      const dump = await piFrame.evaluate(() => ({
        url: location.href.slice(0, 200),
        text: document.body?.innerText?.slice(0, 1200),
      })).catch((err) => String(err));
      console.log("pi-frame on entry-timeout:", JSON.stringify(dump, null, 2));
      throw e;
    }
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
    markCover("B file-review", "verified");
  } finally {
    await app.close().catch(() => {});
    releaseAttachGuard(guard);
    // 本测试 spawn 的实例 run-record 落在 fixture agentDir（run-record 快照
    // 默认读真目录，本来就记不到它）——靠 watchdog ~90s 自退，无残留风险。
  }
});

// ── C 段：活体档——真模型走一轮 prompt→write→回退，验证快照捕获/反放/条目
//    删除的完整链路。模型配置从真 agent 目录复制进隔离 fixture（不进仓库），
//    PI_E2E_LIVE=1 显式开——会真烧模型推理时间。
test("VSCodium C: live prompt turn → revert restores files", { timeout: 480_000 }, async (t) => {
  markCover("C live-revert", "ran");
  if (process.env.PI_E2E_LIVE !== "1") {
    coverSkip(t, "C live-revert", "PI_E2E_LIVE=1 not set");
    return;
  }
  const ctx = prerequisites(t, "C live-revert");
  if (!ctx) return;
  const fixture = makeFixture();
  const agentSeed = await seedAgentConfig(path.join(fixture.root, "agent"));
  if (!agentSeed) {
    coverSkip(t, "C live-revert", "no usable model in real agent dir (engine down or unconfigured)");
    return;
  }
  console.log(`    live model: ${agentSeed.model}`);
  const guard = await guardAttachRange(fixture.port, fixture.port + 9);
  if (guard.oursPort) {
    releaseAttachGuard(guard);
    coverSkip(t, "C live-revert", `real pi-web instance on :${guard.oursPort}`);
    return;
  }
  const { app, piFrame } = await reachPiFrame(ctx, fixture, {
    PI_CODING_AGENT_DIR: agentSeed.agentDir,
  });
  try {
    await piFrame.waitForSelector("textarea", { timeout: 60000 });
    const file = path.join(fixture.workspace, "live-e2e.txt");

    // 真发一轮 prompt——快照由扩展在 turn 开始时经 captureSnapshot 捕获。
    // textarea 存在 ≠ React 已 hydration：fill 能写 DOM 但 Enter/点击要
    // 等 handler 挂上。send 按钮的 disabled={!value.trim()} 由 state 驱动
    // ——enabled 翻转本身就是"React 收到文本"的就绪信号。
    const input = piFrame.locator("textarea").first();
    await input.fill(
      "Use the write tool to create a file named 'live-e2e.txt' in the current directory " +
      "with exact content 'e2e-marker', then stop.",
    );
    // locale 可能随系统解析成 zh——title 三语兼容
    const sendBtn = piFrame.locator('button[title="Send"], button[title="发送"], button[title="傳送"]').first();
    await sendBtn.waitFor({ state: "visible", timeout: 30000 });
    await piFrame.waitForFunction(
      () => !document.querySelector('button[title="Send"],button[title="发送"],button[title="傳送"]')?.disabled,
      null, { timeout: 30000 },
    );
    await sendBtn.click();
    console.log("    prompt sent, waiting for turn (cold JIT + inference may take minutes)…");

    // 轮完成 = 审查卡出现；模型层报错则早退（上轮实测 turn 秒挂却白等 5min）。
    // 判定源用 fixture 会话文件——UI 错误提示文案不稳定。
    const deadline = Date.now() + 300_000;
    let reviewShown = false;
    while (!reviewShown && Date.now() < deadline) {
      if (await piFrame.locator("text=File review").count()) {
        reviewShown = true;
        break;
      }
      const err = lastTurnError(agentSeed.agentDir);
      if (err) throw new Error(`model turn failed: ${err}`);
      await new Promise((r) => setTimeout(r, 1500));
    }
    assert.equal(reviewShown, true, "timed out waiting for File review card");
    assert.equal(existsSync(file), true, "model should have written live-e2e.txt");
    console.log("    turn done, live-e2e.txt on disk — reverting");

    // 回退按钮 hover 才显形（opacity 0），dispatchEvent 直发点击；
    // 两阶段确认：Revert this turn → Confirm
    await piFrame.locator('button[title^="Revert this turn"]').first().dispatchEvent("click");
    await piFrame.locator('button[title="Confirm"]').dispatchEvent("click");

    // created→unlink 语义：write 建的文件回退后应消失
    const revertDeadline = Date.now() + 30_000;
    while (existsSync(file) && Date.now() < revertDeadline) {
      await new Promise((r) => setTimeout(r, 400));
    }
    assert.equal(existsSync(file), false, "live-e2e.txt should be removed after revert");
    console.log("    revert done, file removed");
    markCover("C live-revert", "verified");
  } finally {
    await app.close().catch(() => {});
    releaseAttachGuard(guard);
  }
});

// ── E 段：原生会话树 → 深链 tab——点击树中会话，验证 tab 标题与 iframe
//    URL 双命中（会话 id 真进了 ?session=，页面加载的是该会话非首页）。
//    手工冒烟的历史 bug 面：?session=[object Object] / cwd 盖 session 开首页 /
//    composer tab 升级后点会话开第二个 tab。
test("VSCodium E: session-tree click opens deep-linked session tab", { timeout: 300_000 }, async (t) => {
  markCover("E session-tree", "ran");
  const ctx = prerequisites(t, "E session-tree");
  if (!ctx) return;
  const fixture = makeFixture();
  const seed = seedSession(fixture.root, fixture.workspace); // 会话 id e2e-seed-01
  const guard = await guardAttachRange(fixture.port, fixture.port + 9);
  if (guard.oursPort) {
    releaseAttachGuard(guard);
    coverSkip(t, "E session-tree", `real pi-web instance on :${guard.oursPort}`);
    return;
  }
  const { app, win } = await reachPiFrame(ctx, fixture, {
    PI_CODING_AGENT_DIR: seed.agentDir,
  });
  try {
    // 打开 Pi Sessions 视图容器：activity bar 图标优先，找不到走命令面板
    // （视图命令 = 容器名"Pi Sessions"——aria-label 形态随版本漂移）。
    const actBar = win.locator('.activitybar [aria-label*="Pi Sessions"]').first();
    if (await actBar.count()) {
      await actBar.click();
    } else {
      await runCommand(win, "Pi Sessions");
    }
    const row = win.locator('.monaco-list-row:has-text("e2e seed turn")').first();
    await row.waitFor({ state: "visible", timeout: 60000 });
    await row.click();

    // tab 标题 = "Pi — <会话名>"（openSession 传名；re-key 同机制）
    await win.waitForSelector(
      '.tabs-container .tab:has-text("Pi —"), .monaco-icon-label:has-text("Pi —")',
      { timeout: 60000 },
    );

    // 该 tab 的 iframe URL 必须带 ?session=e2e-seed-01——深链契约的
    // 关键断言：[object Object] 形态会在这里以非 e2e-seed-01 现形。
    // Page.frames() 是全树扁平列表（含 OOPIF 嵌套）——不能先锚"第一个
    // webview 壳"再下探：主面板的壳也在列表里，会话 tab 是第二个 webview。
    const sessionFrame = await waitForFrame(
      win,
      (u) => /^http:\/\/127\.0\.0\.1:\d+\//.test(u) && u.includes("session=e2e-seed-01"),
      60000,
    );
    // 内容必须是会话本体（File review 卡）——深链兑现非首页。
    await sessionFrame.waitForSelector("text=File review", { timeout: 60000 });
    markCover("E session-tree", "verified");
  } finally {
    await app.close().catch(() => {});
    releaseAttachGuard(guard);
  }
});

// ── F 段：热键穿透——iframe 内按 Ctrl+P 应弹出 Quick Open（页面转发 →
//    shell 合成 KeyboardEvent → workbench 原生解析）。你上次报"穿透没了"
//    的回归面：能弹就是链路活着，不能弹就是真断了。
test("VSCodium F: hotkey passthrough reaches workbench", { timeout: 300_000 }, async (t) => {
  markCover("F hotkey", "ran");
  const ctx = prerequisites(t, "F hotkey");
  if (!ctx) return;
  const fixture = makeFixture();
  const guard = await guardAttachRange(fixture.port, fixture.port + 9);
  if (guard.oursPort) {
    releaseAttachGuard(guard);
    coverSkip(t, "F hotkey", `real pi-web instance on :${guard.oursPort}`);
    return;
  }
  const { app, win, piFrame } = await reachPiFrame(ctx, fixture);
  try {
    // 焦点进页面正文（不在输入框——输入框内组合键按设计不转发）。
    await piFrame.waitForSelector("textarea", { timeout: 60000 });
    await piFrame.locator("body").click({ position: { x: 10, y: 10 } }).catch(() => {});
    await piFrame.locator("body").press("Control+P");
    await win.waitForSelector(".quick-input-widget", { state: "visible", timeout: 15000 });
    await win.keyboard.press("Escape"); // 关 Quick Open
    markCover("F hotkey", "verified");
  } finally {
    await app.close().catch(() => {});
    releaseAttachGuard(guard);
  }
});

// ── G 段：宿主重启路径的孤儿占位——"Developer: Restart Extension Host"
//    只重启扩展宿主、tab 保留，与插件更新同构。实测该路径下 webview
//    输入不回到惰性态：deserialize 永不触发，孤儿是永久死壳占位（标题
//    仍在、内容已死）。恢复走树点开的原位交换：关死壳 + 原组重开。
//    断言死壳摘除（旧节点 isConnected=false）、无重影（仍 1 个 tab）、
//    活 iframe 重新到达——DOM 身份断言不适用（本路径无收养）。
test("VSCodium G: ext host restart → orphan stays placeholder; tree-click swaps in place", { timeout: 300_000 }, async (t) => {
  markCover("G orphan-adopt", "ran");
  const ctx = prerequisites(t, "G orphan-adopt");
  if (!ctx) return;
  const fixture = makeFixture();
  const seed = seedSession(fixture.root, fixture.workspace);
  const guard = await guardAttachRange(fixture.port, fixture.port + 9);
  if (guard.oursPort) {
    releaseAttachGuard(guard);
    coverSkip(t, "G orphan-adopt", `real pi-web instance on :${guard.oursPort}`);
    return;
  }
  const { app, win } = await reachPiFrame(ctx, fixture, {
    PI_CODING_AGENT_DIR: seed.agentDir,
  });
  try {
    // 树点开 seed 会话 → session tab（viewType piIde.webview.s.e2e-seed-01）
    const actBar = win.locator('.activitybar [aria-label*="Pi Sessions"]').first();
    if (await actBar.count()) {
      await actBar.click();
    } else {
      await runCommand(win, "Pi Sessions");
    }
    const row = win.locator('.monaco-list-row:has-text("e2e seed turn")').first();
    await row.waitFor({ state: "visible", timeout: 60000 });
    await row.click();
    const tabSel = '.tabs-container .tab:has-text("e2e seed turn")';
    const tabEl = win.locator(tabSel).first();
    await tabEl.waitFor({ state: "visible", timeout: 60000 });
    const orphanTabHandle = await tabEl.elementHandle();
    await waitForFrame(win, (u) => u.includes("session=e2e-seed-01"), 60000);

    // 重启扩展宿主——扩展侧对象死、tab 留：孤儿态的精确复现。
    // 焦点还在 webview OOPIF 里（F1 会被 iframe 吃掉）——先点宿主
    // 状态栏空白处把键盘焦点拉回 workbench。
    await win.locator('.part.statusbar').first()
      .click({ position: { x: 500, y: 12 } })
      .catch(() => {});
    const hostBefore = extensionHostStartCount(fixture.userDataDir);
    await runCommand(win, "Developer: Restart Extension Host");
    await waitForNewExtensionHost(fixture.userDataDir, hostBefore);
    // 激活期枚举+serializer 注册+（若平台支持）deserialize——给足余量，
    // 再等会话树重填充（树条目出现本身说明扩展已复活）。
    await new Promise((r) => setTimeout(r, 15000));
    // 重启后死壳占位仍在原地（标签照旧）——不为它多开 tab。
    const preClick = await win
      .locator('.tabs-container .tab:has-text("e2e seed turn")')
      .count();
    assert.equal(preClick, 1, "dead placeholder should persist — exactly 1 session tab");
    const row2 = win.locator('.monaco-list-row:has-text("e2e seed turn")').first();
    await row2.waitFor({ state: "visible", timeout: 120000 });
    await row2.click();
    // 交换落地 = 死壳被关（旧节点摘除）+ 同位置活面板（iframe 重新到达）。
    await waitForFrame(win, (u) => u.includes("session=e2e-seed-01"), 60000);
    await new Promise((r) => setTimeout(r, 2000));
    const seedTabs = await win
      .locator('.tabs-container .tab:has-text("e2e seed turn")')
      .count();
    assert.equal(
      seedTabs, 1,
      `swap should leave exactly 1 session tab, got ${seedTabs}`,
    );
    const orphanAlive = await orphanTabHandle
      .evaluate((el) => el.isConnected)
      .catch(() => false);
    assert.equal(
      orphanAlive, false,
      "dead shell should be closed by the swap — no revive path under host restart",
    );
    markCover("G orphan-adopt", "verified");
  } finally {
    await app.close().catch(() => {});
    releaseAttachGuard(guard);
  }
});

// ── H 段：窗口重载路径——vsix 更新实际走 reloadWindow。deserialize 按
//    tab 懒触发（后台孤儿的输入不 resolve 就不来），故后台孤儿留作
//    懒占位：树点开同会话 → openSession 原位交换（关占位+原组重开），
//    用户视角=点了会话、tab 活了、仍只有 1 个。断言的就是这个不重影闭环。
test("VSCodium H: window reload → orphan session tab adopted, no duplicate", { timeout: 300_000 }, async (t) => {
  markCover("H reload-adopt", "ran");
  const ctx = prerequisites(t, "H reload-adopt");
  if (!ctx) return;
  const fixture = makeFixture();
  const seed = seedSession(fixture.root, fixture.workspace);
  const guard = await guardAttachRange(fixture.port, fixture.port + 9);
  if (guard.oursPort) {
    releaseAttachGuard(guard);
    coverSkip(t, "H reload-adopt", `real pi-web instance on :${guard.oursPort}`);
    return;
  }
  const { app, win } = await reachPiFrame(ctx, fixture, {
    PI_CODING_AGENT_DIR: seed.agentDir,
  });
  try {
    const actBar = win.locator('.activitybar [aria-label*="Pi Sessions"]').first();
    if (await actBar.count()) {
      await actBar.click();
    } else {
      await runCommand(win, "Pi Sessions");
    }
    const row = win.locator('.monaco-list-row:has-text("e2e seed turn")').first();
    await row.waitFor({ state: "visible", timeout: 60000 });
    await row.click();
    await win.waitForSelector(
      '.tabs-container .tab:has-text("e2e seed turn")',
      { timeout: 60000 },
    );
    await waitForFrame(win, (u) => u.includes("session=e2e-seed-01"), 60000);

    // 把会话 tab 压到后台（点开文件 tab）——懒 deserialize 的关键变量：
    // 恢复时它不是组内活动编辑器 → 不 resolve → 留作懒占位，
    // 由下面点开会话行的原位交换接管。
    await win.locator('.tabs-container .tab:has-text("hello.txt")').first()
      .click()
      .catch(() => {});
    await win.locator('.part.statusbar').first()
      .click({ position: { x: 500, y: 12 } })
      .catch(() => {});
    await reloadWindow(win);
    // 重载后 workbench 重建——等面板与扩展激活落地。
    await win.waitForSelector(".monaco-workbench", { timeout: 90000 });
    await new Promise((r) => setTimeout(r, 15000));
    const row2 = win.locator('.monaco-list-row:has-text("e2e seed turn")').first();
    await row2.waitFor({ state: "visible", timeout: 120000 });
    await row2.click();
    await new Promise((r) => setTimeout(r, 4000));
    const seedTabs = await win
      .locator('.tabs-container .tab:has-text("e2e seed turn")')
      .count();
    assert.equal(
      seedTabs, 1,
      `window-reload orphan should be adopted (still 1 session tab), got ${seedTabs}`,
    );
    markCover("H reload-adopt", "verified");
  } finally {
    await app.close().catch(() => {});
    releaseAttachGuard(guard);
  }
});

// ── I 段：窗口重载 + 后台孤儿——deserialize 按 tab 懒触发（恢复时仅
//    组内活动者 resolve），后台孤儿留作惰性占位符，永不主动关闭。
//    三去向同测：s01 活动者自动收养 / s03 点占位原地收养 / s02 树点
//    同会话原位交换（关占位+同组重开，不重影）。占位惰性断言为关键
//    证据：后台孤儿的 session iframe 绝不加载。
test("VSCodium I: reload leaves background orphans as lazy placeholders; click adopts, tree-click swaps", { timeout: 300_000 }, async (t) => {
  markCover("I lazy-orphan", "ran");
  const ctx = prerequisites(t, "I lazy-orphan");
  if (!ctx) return;
  const fixture = makeFixture();
  seedSession(fixture.root, fixture.workspace);
  seedSession(fixture.root, fixture.workspace, { id: "e2e-seed-02", firstMessage: "e2e seed two" });
  seedSession(fixture.root, fixture.workspace, { id: "e2e-seed-03", firstMessage: "e2e seed three" });
  const seed = { agentDir: path.join(fixture.root, "agent") };
  const guard = await guardAttachRange(fixture.port, fixture.port + 9);
  if (guard.oursPort) {
    releaseAttachGuard(guard);
    coverSkip(t, "I lazy-orphan", `real pi-web instance on :${guard.oursPort}`);
    return;
  }
  const { app, win } = await reachPiFrame(ctx, fixture, {
    PI_CODING_AGENT_DIR: seed.agentDir,
  });
  const piTab = (name) => `.tabs-container .tab:has-text("${name}")`;
  const hasSessionFrame = (id) =>
    win.frames().some((f) => f.url().includes(`session=${id}`));
  try {
    const actBar = win.locator('.activitybar [aria-label*="Pi Sessions"]').first();
    if (await actBar.count()) {
      await actBar.click();
    } else {
      await runCommand(win, "Pi Sessions");
    }
    // 依次点开三个会话——同键锚定 sessionPanels.column()，全叠进会话组。
    for (const [row, id] of [
      ["e2e seed turn", "e2e-seed-01"],
      ["e2e seed two", "e2e-seed-02"],
      ["e2e seed three", "e2e-seed-03"],
    ]) {
      const r = win.locator(`.monaco-list-row:has-text("${row}")`).first();
      await r.waitFor({ state: "visible", timeout: 120000 });
      await r.click();
      await waitForFrame(win, (u) => u.includes(`session=${id}`), 60000);
    }
    // 点回 seed-01 的 tab → 它是组内活动编辑器，02/03 沦为后台孤儿。
    await win.locator(piTab("e2e seed turn")).first().click();
    await win.locator(".part.statusbar").first()
      .click({ position: { x: 500, y: 12 } })
      .catch(() => {});
    await reloadWindow(win);
    await win.waitForSelector(".monaco-workbench", { timeout: 90000 });
    // 激活枚举+serializer 注册在数秒内；留足余量再断言占位惰性。
    await new Promise((r) => setTimeout(r, 12000));

    // s01 自动收养落地（帧出现 = deserialize 链整条走通）；若后台孤儿
    // 也有帧则说明恢复路径 eager-resolve——dump 现场便于取证。
    await waitForFrame(win, (u) => u.includes("session=e2e-seed-01"), 60000);
    await new Promise((r) => setTimeout(r, 1500));
    const frames = win.frames().map((f) => f.url()).filter((u) => u.startsWith("http"));
    t.diagnostic(`frames post-reload: ${JSON.stringify(frames)}`);
    const tabDump = await win
      .locator(".tabs-container .tab")
      .evaluateAll((els) =>
        els.map((el) => `${el.getAttribute("aria-label")}|sel=${el.getAttribute("aria-selected")}`)
      )
      .catch(() => ["<dump failed>"]);
    t.diagnostic(`tabs post-reload: ${JSON.stringify(tabDump)}`);
    assert.equal(hasSessionFrame("e2e-seed-02"), false,
      "background orphan e2e-seed-02 loaded without a click — placeholder not inert");
    assert.equal(hasSessionFrame("e2e-seed-03"), false,
      "background orphan e2e-seed-03 loaded without a click — placeholder not inert");
    assert.equal(await win.locator(piTab("e2e seed two")).count(), 1);
    assert.equal(await win.locator(piTab("e2e seed three")).count(), 1);

    // 去向二：点死占位本身 → deserialize → adopt 原地复活（节点保留）。
    const t3Handle = await win.locator(piTab("e2e seed three")).first().elementHandle();
    await win.locator(piTab("e2e seed three")).first().click();
    await waitForFrame(win, (u) => u.includes("session=e2e-seed-03"), 60000);
    const stillThere = await t3Handle.evaluate((el) => el.isConnected).catch(() => false);
    assert.equal(stillThere, true, "clicked placeholder should adopt in place — same DOM node");

    // 去向三：树点同会话 → openSession 原位交换（占位收走，活面板落原组）。
    const row2 = win.locator('.monaco-list-row:has-text("e2e seed two")').first();
    await row2.waitFor({ state: "visible", timeout: 120000 });
    await row2.click();
    await waitForFrame(win, (u) => u.includes("session=e2e-seed-02"), 60000);
    assert.equal(await win.locator(piTab("e2e seed two")).count(), 1,
      "swap must leave exactly one session-02 tab — no placeholder/duplicate");
    assert.equal(await win.locator(piTab("e2e seed three")).count(), 1);
    markCover("I lazy-orphan", "verified");
  } finally {
    await app.close().catch(() => {});
    releaseAttachGuard(guard);
  }
});

// ── J 段：已删会话的占位自清理——重载恢复出的后台孤儿是惰性输入，
//    点开才 resolve → deserialize → sessionExists=false → 原地关窗。
//    （宿主重启路径下输入不回惰性态、deserialize 永不触发——死壳只由
//    reveal/交换路径兜底，本段专测重载链。）
test("VSCodium J: deleted session's orphan placeholder self-cleans on click (window reload)", { timeout: 300_000 }, async (t) => {
  markCover("J orphan-selfclean", "ran");
  const ctx = prerequisites(t, "J orphan-selfclean");
  if (!ctx) return;
  const fixture = makeFixture();
  seedSession(fixture.root, fixture.workspace);
  const seed2 = seedSession(fixture.root, fixture.workspace, {
    id: "e2e-seed-02",
    firstMessage: "e2e seed two",
  });
  const guard = await guardAttachRange(fixture.port, fixture.port + 9);
  if (guard.oursPort) {
    releaseAttachGuard(guard);
    coverSkip(t, "J orphan-selfclean", `real pi-web instance on :${guard.oursPort}`);
    return;
  }
  const { app, win } = await reachPiFrame(ctx, fixture, {
    PI_CODING_AGENT_DIR: seed2.agentDir,
  });
  const piTab = (name) => `.tabs-container .tab:has-text("${name}")`;
  try {
    const actBar = win.locator('.activitybar [aria-label*="Pi Sessions"]').first();
    if (await actBar.count()) {
      await actBar.click();
    } else {
      await runCommand(win, "Pi Sessions");
    }
    for (const [row, id] of [
      ["e2e seed turn", "e2e-seed-01"],
      ["e2e seed two", "e2e-seed-02"],
    ]) {
      const r = win.locator(`.monaco-list-row:has-text("${row}")`).first();
      await r.waitFor({ state: "visible", timeout: 120000 });
      await r.click();
      await waitForFrame(win, (u) => u.includes(`session=${id}`), 60000);
    }
    // seed-01 回活动位 → seed-02 成后台孤儿（重载恢复时惰性、不 resolve）。
    await win.locator(piTab("e2e seed turn")).first().click();
    await win.locator(".part.statusbar").first()
      .click({ position: { x: 500, y: 12 } })
      .catch(() => {});
    await reloadWindow(win);
    await win.waitForSelector(".monaco-workbench", { timeout: 90000 });
    await new Promise((r) => setTimeout(r, 10000));

    // s01 自动收养（帧到达 = 复活链整条走通）；s02 仍是死占位。
    await waitForFrame(win, (u) => u.includes("session=e2e-seed-01"), 120000);
    const row2 = win.locator('.monaco-list-row:has-text("e2e seed two")').first();
    await row2.waitFor({ state: "visible", timeout: 120000 });

    // 删 s02 文件 → 轮询拾到 → 行消失 = "清单已载且查无此会话"成立。
    rmSync(seed2.sessionFile, { force: true });
    await row2.waitFor({ state: "detached", timeout: 60000 });

    // 点死占位 → resolve → deserialize → sessionExists=false → 自关。
    const dead = win.locator(piTab("e2e seed two")).first();
    await dead.waitFor({ state: "visible", timeout: 30000 });
    const qi = win.locator(".quick-input-widget:visible").first();
    if (await qi.count().catch(() => 0)) {
      t.diagnostic(`quick-input blocking click: ${(await qi.innerText().catch(() => "")).slice(0, 300)}`);
      await win.keyboard.press("Escape");
      await qi.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    }
    await dead.click();
    await dead.waitFor({ state: "detached", timeout: 30000 });
    assert.equal(await win.locator(piTab("e2e seed two")).count(), 0,
      "deleted session's placeholder should dispose itself on click");
    markCover("J orphan-selfclean", "verified");
  } finally {
    await app.close().catch(() => {});
    releaseAttachGuard(guard);
  }
});

// ── K 段：项目级 settings.json 直达编辑器——视图菜单命令对缺失文件开
//    "路径绑定的 untitled"：断言打开后磁盘仍无文件（延迟写入语义）、
//    Ctrl+S 后落盘为合法 JSON 空对象（骨架零覆盖键）；文件存在后再调
//    命令走普通打开，不再产生第二个 settings.json tab。
test("VSCodium K: Edit Project settings.json — untitled until save, then file editor", { timeout: 300_000 }, async (t) => {
  markCover("K project-settings", "ran");
  const ctx = prerequisites(t, "K project-settings");
  if (!ctx) return;
  const fixture = makeFixture();
  const guard = await guardAttachRange(fixture.port, fixture.port + 9);
  if (guard.oursPort) {
    releaseAttachGuard(guard);
    coverSkip(t, "K project-settings", `real pi-web instance on :${guard.oursPort}`);
    return;
  }
  const { app, win } = await reachPiFrame(ctx, fixture);
  try {
    const target = path.join(fixture.workspace, ".pi", "settings.json");
    const tabSel = '.tabs-container .tab:has-text("settings.json")';

    // 键盘焦点拉回 workbench——pi-web iframe 持焦时 F1 被吃（同 G 段）。
    await win.locator('.part.statusbar').first()
      .click({ position: { x: 500, y: 12 } })
      .catch(() => {});
    await runCommand(win, "Edit Project settings.json");
    await win.waitForSelector(tabSel, { timeout: 30000 });
    // 延迟写入：untitled 已开但磁盘仍无文件。
    await win.waitForSelector(`${tabSel}.dirty`, { timeout: 15000 });
    assert.equal(existsSync(target), false, "untitled must not touch disk before save");

    // 未保存再调命令：existsSync 看不见 pending untitled，漏判会
    // 往同一文档里再插一副骨架（保存即成坏 JSON）。只能激活。
    await runCommand(win, "Edit Project settings.json");
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(
      await win.locator(tabSel).count(), 1,
      "re-invoke must reuse the pending untitled, not open a second tab",
    );
    const lines = await win.locator(".view-lines").allInnerTexts();
    const squashed = lines.map((t2) => t2.replace(/\s+/g, ""));
    assert.ok(
      !squashed.some((t2) => t2.includes("{}{}")),
      "re-invoke must not append a second skeleton to the pending untitled",
    );

    // 点 tab 激活并把 DOM 焦点交给编辑器，Ctrl+S 落到活动编辑器上。
    await win.locator(tabSel).first().click();
    await win.keyboard.press("Control+S");
    for (let i = 0; i < 50 && !existsSync(target); i++) {
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.equal(existsSync(target), true, "save should materialize .pi/settings.json");
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), {});

    // 文件存在后再调命令 → 普通打开：仍只有 1 个 settings.json tab、不脏。
    await runCommand(win, "Edit Project settings.json");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await win.locator(tabSel).count(), 1, "existing file should focus the same editor");
    assert.equal(
      await win.locator(`${tabSel}.dirty`).count(), 0,
      "re-opened file editor must not be dirty",
    );
    markCover("K project-settings", "verified");
  } finally {
    await app.close().catch(() => {});
    releaseAttachGuard(guard);
  }
});

/** fixture agentDir 里最新会话文件出现 turn 错误时，提取 errorMessage。 */
function lastTurnError(agentDir) {
  try {
    const sessDir = path.join(agentDir, "sessions");
    if (!existsSync(sessDir)) return null;
    const files = [];
    for (const d of readdirSync(sessDir)) {
      for (const f of readdirSync(path.join(sessDir, d))) {
        if (f.endsWith(".jsonl")) files.push(path.join(sessDir, d, f));
      }
    }
    for (const f of files) {
      for (const line of readFileSync(f, "utf8").split("\n")) {
        if (line.includes('"stopReason":"error"')) {
          try {
            const m = JSON.parse(line).message;
            return m?.errorMessage ?? "stopReason=error";
          } catch { return "stopReason=error"; }
        }
      }
    }
  } catch { /* 读不了就当没错——让等待继续 */ }
  return null;
}

// D 段（watchdog 自退）：关窗后心跳停，~autoStopAfterSec(90s 起)+余量内
// 端口必须释放。慢路径默认不跑，PI_E2E_SLOW=1 显式开。
test("VSCodium D: spawned server self-stops after window closes", { timeout: 300_000 }, async (t) => {
  markCover("D watchdog", "ran");
  if (process.env.PI_E2E_SLOW !== "1") {
    coverSkip(t, "D watchdog", "PI_E2E_SLOW=1 not set");
    return;
  }
  const ctx = prerequisites(t, "D watchdog");
  if (!ctx) return;
  const fixture = makeFixture();
  // 本测试断言的是"我们 spawn 的实例自退"——attach 到真身实例会让
  // 断言对象错成别人的 server，先隔离。
  const guard = await guardAttachRange(fixture.port, fixture.port + 9);
  if (guard.oursPort) {
    releaseAttachGuard(guard);
    coverSkip(t, "D watchdog", `real pi-web instance on :${guard.oursPort}`);
    return;
  }
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
  releaseAttachGuard(guard);
  if (alive) throw new Error(`server on :${port} still answering after window closed + 180s`);
  markCover("D watchdog", "verified");
});

// 覆盖度汇总：把"哪段真验了/哪段跳了"明明白白打在尾部——
// 不新增断言（环境性 skip 合理），但绝不能让 4 段静默缺席。
test("E2E coverage summary", () => {
  const marks = { verified: "✔", ran: "●(no result)", skipped: "⤼" };
  const lines = coverage.map(
    (c) => `  ${marks[c.status] ?? "?"} ${c.seg}${c.note ? ` — ${c.note}` : ""}`,
  );
  const unverified = coverage.filter((c) => c.status !== "verified");
  console.log("\n=== E2E COVERAGE ===");
  console.log(lines.length ? lines.join("\n") : "  (no segments ran)");
  if (unverified.length) {
    console.log(
      `  ⚠ ${unverified.length} segment(s) NOT verified this run — ` +
      `see reasons above; rerun with the right env (PI_E2E_LIVE=1 / PI_E2E_SLOW=1 / no real instance on 303x) to cover.`,
    );
  } else {
    console.log("  all segments verified.");
  }
});
