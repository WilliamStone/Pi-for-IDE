// 一次性探针：验证非激活 webview tab 内 OOPIF iframe 的 visibilityState。
import { _electron as electron } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanElectronEnv, findVscodium, guardAttachRange, installVsix, latestVsix,
  makeFixture, releaseAttachGuard, runCommand, waitForFrame,
} from "./helpers.mjs";
import { seedSession } from "./session-fixture.mjs";

const extDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const { exe, cli } = findVscodium();
const vsix = latestVsix(extDir);
const fixture = makeFixture();
seedSession(fixture.root, fixture.workspace);
seedSession(fixture.root, fixture.workspace, { id: "e2e-seed-02", firstMessage: "e2e seed two" });
const agentDir = path.join(fixture.root, "agent");
const guard = await guardAttachRange(fixture.port, fixture.port + 9);
installVsix(cli, vsix, fixture);
const app = await electron.launch({
  executablePath: exe,
  env: { ...cleanElectronEnv(), PI_IDE_ATTACH_RANGE: `${fixture.port}-${fixture.port + 9}`, PI_CODING_AGENT_DIR: agentDir },
  args: ["--user-data-dir", fixture.userDataDir, "--extensions-dir", fixture.extensionsDir,
    "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes",
    "--no-sandbox", "--disable-gpu-sandbox", fixture.workspace],
  timeout: 60000,
});
const win = await app.firstWindow();
const findPiFrame = async (id) => {
  for (const f of win.frames()) {
    if (f.url().includes(`session=${id}`)) return f;
  }
  return null;
};
const visOf = async (id) => {
  const f = await findPiFrame(id);
  return f ? await f.evaluate(() => document.visibilityState) : "no-frame";
};
const visPoll = async () => {
  const out = {};
  for (const id of ["e2e-seed-01", "e2e-seed-02"]) out[id] = await visOf(id);
  return out;
};
try {
  await win.waitForSelector(".monaco-workbench", { timeout: 60000 });
  const actBar = win.locator('.activitybar [aria-label*="Pi Sessions"]').first();
  if (await actBar.count()) await actBar.click(); else await runCommand(win, "Pi Sessions");
  for (const [row, id] of [["e2e seed turn", "e2e-seed-01"], ["e2e seed two", "e2e-seed-02"]]) {
    const r = win.locator(`.monaco-list-row:has-text("${row}")`).first();
    await r.waitFor({ state: "visible", timeout: 120000 });
    await r.click();
    await waitForFrame(win, (u) => u.includes(`session=${id}`), 90000);
    await new Promise((r2) => setTimeout(r2, 1500));
  }
  console.log("both open:", JSON.stringify(await visPoll()));
  // 切到 seed-01 tab → seed-02 沦为后台
  await win.locator('.tabs-container .tab:has-text("e2e seed turn")').first().click();
  await new Promise((r) => setTimeout(r, 2500));
  console.log("after activating s01 (s02 bg):", JSON.stringify(await visPoll()));
  // 再切回 s02
  await win.locator('.tabs-container .tab:has-text("e2e seed two")').first().click();
  await new Promise((r) => setTimeout(r, 2500));
  console.log("after activating s02 (s01 bg):", JSON.stringify(await visPoll()));
} finally {
  await app.close().catch(() => {});
  releaseAttachGuard(guard);
}
