import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { _electron as electron } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanElectronEnv, findVscodium, guardAttachRange, installVsix, latestVsix,
  makeFixture, openPiPanelViaEditorTitle, releaseAttachGuard, runCommand, waitForFrame,
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

// ── G 段：孤儿收养——"Developer: Restart Extension Host" 只重启扩展宿主、
//    tab 保留，与插件更新同构。收养成功 → 再点同会话复用原 tab（仍 1 个
//    "Pi —" tab）；deserialize 不触发 → 会开出第 2 个 tab。
test("VSCodium G: ext host restart → orphaned session tab adopted, no duplicate", { timeout: 300_000 }, async (t) => {
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
    await runCommand(win, "Developer: Restart Extension Host");
    // 激活期枚举+serializer 注册+（若平台支持）deserialize——给足余量，
    // 再等会话树重填充（树条目出现本身说明扩展已复活）。
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
      `orphan should be adopted (still 1 session tab), got ${seedTabs} — deserialize likely never fired`,
    );
    // DOM 身份断言：收养 = 原 tab 节点仍在 DOM；被关掉重开 = 节点已摘除
    // ——seedTabs==1 单靠计数区分不了这两条路径。
    const orphanAlive = await orphanTabHandle
      .evaluate((el) => el.isConnected)
      .catch(() => false);
    assert.equal(
      orphanAlive, true,
      "original tab node replaced — orphan was closed & reopened, not adopted",
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
    await runCommand(win, "Developer: Reload Window");
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
