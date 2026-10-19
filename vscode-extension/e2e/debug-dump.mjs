// 调试帮手：拉起 fixture、开面板、dump webview frame 内部 DOM 状态。
import { _electron as electron } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanElectronEnv, findVscodium, installVsix, latestVsix, makeFixture, waitForFrame,
} from "./helpers.mjs";

const extDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const { exe, cli } = findVscodium();
const vsix = latestVsix(extDir);
const fixture = makeFixture();
installVsix(cli, vsix, fixture);
const app = await electron.launch({
  executablePath: exe,
  env: cleanElectronEnv(),
  args: ["--user-data-dir", fixture.userDataDir, "--extensions-dir", fixture.extensionsDir,
    "--disable-workspace-trust", "--skip-welcome", "--no-sandbox", fixture.workspace],
});
try {
  const win = await app.firstWindow();
  // 每个 frame 文档加载前注入探针（先于 shell.js），捕获真 serverReady + fetch 实况
  await win.addInitScript(() => {
    window.__srvReady = [];
    window.__fetchLog = [];
    window.addEventListener("message", (e) => {
      const p = e.data?.payload;
      if (p?.kind === "serverReady") window.__srvReady.push("RDY:" + JSON.stringify(p));
      if (p?.kind === "serverError") window.__srvReady.push("ERR:" + JSON.stringify(p));
      if (p?.kind === "status") window.__srvReady.push("ST:" + String(p.text).slice(0, 80));
    });
    const origFetch = window.fetch?.bind(window);
    if (origFetch) {
      window.fetch = (...a) => origFetch(...a)
        .then((r) => { window.__fetchLog.push("ok " + a[0]); return r; })
        .catch((e) => { window.__fetchLog.push("err " + a[0] + " | " + e); throw e; });
    }
  });
  await win.waitForSelector(".monaco-workbench", { timeout: 60000 });
  const row = win.locator('.explorer-viewlet .monaco-list-row:has-text("hello.txt")').first();
  await row.click();
  const btn = win.locator('.editor-actions .codicon-comment-discussion, .editor-actions [aria-label="Open"]').first();
  await btn.click();
  win.on("console", (m) => console.log("[console]", m.type(), m.text().slice(0, 200)));
  win.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));

  await win.waitForSelector("iframe.webview", { timeout: 30000 });
  const wv = await waitForFrame(win, (u) => /vscode-webview:/i.test(u), 60000);
  console.log("webview frame url:", wv.url());
  const fake = await waitForFrame(wv, (u) => /fake\.html/i.test(u), 30000);
  console.log("fake frame url:", fake.url());
  await new Promise((r) => setTimeout(r, 8000));
  // statusbar 上有扩展标出的实际服务地址（"Pi for IDE — running at http://..."）
  const status = await win.evaluate(() =>
    [...document.querySelectorAll(".statusbar-item, .statusbar-item a")]
      .map((e) => e.getAttribute("aria-label") || e.textContent || "")
      .filter((t) => /Pi|IDE|303|127\.0/.test(t)));
  console.log("statusbar pi items:", status);
  // 此刻 303x 谁在听？spawn 出的 server.js 子进程是谁？
  const { execSync } = await import("node:child_process");
  try {
    console.log("netstat:", execSync('netstat -ano | findstr "303" | findstr LISTEN').toString());
    const ps = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name like \'%VSCodium%\'\\" | Where-Object {$_.CommandLine -like \'*server.js*\'} | Select-Object ProcessId,CommandLine | Format-List"'
    ).toString();
    console.log("server procs:", ps.slice(0, 1500));
  } catch (e) { console.log("probe err", String(e).slice(0, 200)); }
  await new Promise((r) => setTimeout(r, 5000));
  const state = await fake.evaluate(() => ({
    gateHtml: document.getElementById("gate-text")?.innerHTML?.slice(0, 300),
    gateClass: document.getElementById("gate")?.className,
    frameSrc: document.getElementById("pi-web-frame")?.getAttribute("src"),
    frameDisplay: document.getElementById("pi-web-frame")?.style?.display,
    childCount: document.querySelectorAll("iframe").length,
    bodyHtml: document.body?.innerHTML?.slice(0, 500),
  })).catch((e) => ({ err: String(e) }));
  console.log("shell state:", JSON.stringify(state, null, 2));
  console.log("fake child frames:", fake.childFrames().map((f) => f.url()));

  // 在 webview 里手动重放 shell.js 的 probe fetch，拿真实失败原因
  const probeResult = await fake.evaluate(async () => {
    const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content");
    let res;
    try {
      const r = await fetch("http://127.0.0.1:3030", { method: "HEAD", mode: "no-cors", cache: "no-store" });
      res = `ok status=${r.status}`;
    } catch (e) {
      res = `err ${e}`;
    }
    return { csp, res };
  }).catch((e) => ({ err: String(e) }));
  console.log("manual probe:", JSON.stringify(probeResult, null, 2));

  const captured = await fake.evaluate(() => ({
    srvReady: window.__srvReady,
    fetchLog: window.__fetchLog,
  }));
  console.log("captured:", JSON.stringify(captured, null, 2));
} finally {
  await app.close().catch(() => {});
}
