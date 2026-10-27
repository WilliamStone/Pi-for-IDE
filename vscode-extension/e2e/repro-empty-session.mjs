// 复现：reload 后活动 session 孤儿收养 → iframe 有壳无对话内容。
// 循环 Reload Window，每次收养后等 "e2e seed turn" 正文出现；
// 超时即抓现场：帧 URL、body 文本、直接在帧里重放 /api/sessions/<id>。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import {
  cleanElectronEnv, findVscodium, guardAttachRange, installVsix,
  latestVsix, makeFixture, openPiPanelViaEditorTitle,
  releaseAttachGuard, reloadWindow, waitForFrame,
} from "./helpers.mjs";
import { seedSession } from "./session-fixture.mjs";

const extDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ROUNDS = Number(process.env.PI_E2E_REPRO_ROUNDS ?? 12);

const vscodium = findVscodium();
if (!vscodium) {
  console.log("no VSCodium — skip");
  process.exit(0);
}
const vsix = latestVsix(extDir);
if (!vsix) {
  console.log("no vsix — run npm run package first");
  process.exit(1);
}

const fixture = makeFixture();
const seed = seedSession(fixture.root, fixture.workspace);
const guard = await guardAttachRange(fixture.port, fixture.port + 9);
if (guard.oursPort) {
  releaseAttachGuard(guard);
  console.log(`real pi-web on :${guard.oursPort} — abort`);
  process.exit(2);
}

installVsix(vscodium.cli, vsix, fixture);
const app = await electron.launch({
  executablePath: vscodium.exe,
  env: { ...cleanElectronEnv(), PI_IDE_ATTACH_RANGE: `${fixture.port}-${fixture.port + 9}`, PI_CODING_AGENT_DIR: seed.agentDir },
  args: [
    "--user-data-dir", fixture.userDataDir,
    "--extensions-dir", fixture.extensionsDir,
    "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes",
    "--no-sandbox", "--disable-gpu-sandbox",
    fixture.workspace,
  ],
  timeout: 60000,
});
const win = await app.firstWindow();
await win.waitForSelector(".monaco-workbench", { timeout: 60000 });

async function openSessionTab() {
  await openPiPanelViaEditorTitle(win);
  const actBar = win.locator('.activitybar [aria-label*="Pi Sessions"]').first();
  if (await actBar.count()) await actBar.click();
  const row = win.locator('.monaco-list-row:has-text("e2e seed turn")').first();
  await row.waitFor({ state: "visible", timeout: 120000 });
  await row.click();
  await waitForFrame(win, (u) => u.includes("session=e2e-seed-01"), 60000);
}

async function piFrameHandle() {
  // 直接全帧找 pi-web 文档帧（URL 含 session= 的 http 帧）。
  const f = await waitForFrame(
    win,
    (u) => /^http:\/\/127\.0\.0\.1:\d+\//.test(u) && u.includes("session=e2e-seed-01"),
    60000,
  );
  return f;
}

async function dumpFailure(round, piFrame, note) {
  console.log(`\n=== FAILURE round ${round} (${note}) ===`);
  try {
    console.log("frame url:", piFrame.url());
  } catch { /* dead */ }
  try {
    const text = await piFrame.evaluate(() => document.body?.innerText?.slice(0, 2500));
    console.log("body text:\n", text);
  } catch (e) {
    console.log("body dump failed:", String(e));
  }
  try {
    const probe = await piFrame.evaluate(async () => {
      const out = {};
      for (const path of [
        "/api/sessions/e2e-seed-01?deferThinking=1&deferMedia=1&tree=summary&force=1",
        "/api/sessions",
        "/api/agent/e2e-seed-01",
      ]) {
        try {
          const r = await fetch(path, { cache: "no-store" });
          const t = await r.text();
          out[path] = { status: r.status, head: t.slice(0, 400) };
        } catch (e) {
          out[path] = { error: String(e) };
        }
      }
      return out;
    });
    console.log("in-frame API replay:", JSON.stringify(probe, null, 2));
  } catch (e) {
    console.log("in-frame replay failed:", String(e));
  }
  try {
    const tabs = await win.locator(".tabs-container .tab")
      .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
    console.log("tabs:", JSON.stringify(tabs));
  } catch { /* ignore */ }
}

try {
  await openSessionTab();
  let failures = 0;
  for (let round = 1; round <= ROUNDS; round++) {
    await win.locator(".part.statusbar").first()
      .click({ position: { x: 500, y: 12 } }).catch(() => {});
    await reloadWindow(win);
    await win.waitForSelector(".monaco-workbench", { timeout: 90000 });
    console.log(`round ${round}: reloaded, waiting for adopted frame…`);
    let piFrame;
    try {
      piFrame = await piFrameHandle();
    } catch {
      await dumpFailure(round, { url: () => "(none)", evaluate: async () => { throw new Error("no frame"); } }, "no session frame");
      failures++;
      continue;
    }
    try {
      await piFrame.waitForFunction(
        () => document.body?.innerText?.includes("e2e seed turn"),
        undefined,
        { timeout: 45000 },
      );
      console.log(`round ${round}: OK — content present`);
    } catch {
      await dumpFailure(round, piFrame, "no content");
      failures++;
    }
  }
  console.log(`\n${failures}/${ROUNDS} rounds failed`);
} finally {
  await app.close().catch(() => {});
  releaseAttachGuard(guard);
}
