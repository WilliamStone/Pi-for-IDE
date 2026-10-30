import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

/**
 * resources/shell.js 的状态机测试——真实加载脚本进 jsdom，驱动
 * window.postMessage 事件并断言 DOM/桥消息。覆盖的正是一直靠手工
 * 冒烟验证的那层：shell painted 回执、serverReady 探测、probe 超时
 * 降级页、serverError 渲染、embed/host 双向转发。
 */

const SHELL_SRC = readFileSync(
  new URL("../resources/shell.js", import.meta.url),
  "utf8",
);

const SHELL_HTML = `<!doctype html><html><body>
<div id="gate"><div id="gate-text"></div></div>
<iframe id="pi-web-frame"></iframe>
</body></html>`;

function bootShell({ fetchImpl } = {}) {
  const dom = new JSDOM(SHELL_HTML, { runScripts: "outside-only" });
  const { window } = dom;
  const posted = [];
  const persisted = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => posted.push(m),
    setState: (s) => persisted.push(s),
    getState: () => undefined,
  });
  window.fetch = fetchImpl ?? (async () => ({}));
  window.eval(SHELL_SRC);
  const gate = window.document.getElementById("gate");
  const gateText = window.document.getElementById("gate-text");
  const frame = window.document.getElementById("pi-web-frame");
  const post = (data) =>
    window.dispatchEvent(new window.MessageEvent("message", { data }));
  return { window, posted, persisted, gate, gateText, frame, post };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test("load posts 'shell painted' handshake", () => {
  const { posted } = bootShell();
  assert.equal(posted[0].source, "piIde.log");
  assert.equal(posted[0].text, "shell painted");
});

test("status message updates gate text", () => {
  const { gateText, post } = bootShell();
  post({ source: "host", payload: { kind: "status", text: "Loading…" } });
  assert.match(gateText.innerHTML, /^Loading…/);
});

test("serverReady probes then loads iframe; load event hides gate", async () => {
  const { posted, gate, frame, post, window } = bootShell();
  post({
    source: "host",
    payload: { kind: "serverReady", url: "http://127.0.0.1:3031/", probe: "http://127.0.0.1:3031/api/embed" },
  });
  await delay(20); // 让 probeAndShow 的 await fetch 落定
  assert.ok(posted.some((m) => m.text === "server probe passed, setting iframe.src"));
  assert.match(String(frame.src), /127\.0\.0\.1:3031/);
  frame.dispatchEvent(new window.Event("load"));
  assert.equal(gate.style.display, "none");
  assert.equal(frame.style.display, "block");
  assert.ok(posted.some((m) => m.text === "iframe page loaded"));
});

test("same-URL serverReady while a navigation is in-flight is deduped", async () => {
  // reload 场景：deserialize 的 refresh 与实例标记 watcher 的
  // refreshAllPanels 同拍各发一条 serverReady——第二条命中在飞导航时
  // 不得重指 src（load 前二次赋值是批量恢复 wedge 的源头）。
  const { posted, post } = bootShell();
  const payload = {
    kind: "serverReady",
    url: "http://127.0.0.1:3031/",
    probe: "http://127.0.0.1:3031/",
  };
  post({ source: "host", payload });
  await delay(20); // 探测过 → src 已设，load 尚未触发（在飞）
  post({ source: "host", payload });
  await delay(20);
  assert.equal(
    posted.filter((m) => m.text === "server probe passed, setting iframe.src").length,
    1,
  );
});

test("serverReady with a different URL still re-navigates mid-flight", async () => {
  const { posted, frame, post } = bootShell();
  post({
    source: "host",
    payload: { kind: "serverReady", url: "http://127.0.0.1:3031/a", probe: "x" },
  });
  await delay(20);
  post({
    source: "host",
    payload: { kind: "serverReady", url: "http://127.0.0.1:3031/b", probe: "x" },
  });
  await delay(20);
  assert.equal(
    posted.filter((m) => m.text === "server probe passed, setting iframe.src").length,
    2,
  );
  assert.match(String(frame.src), /3031\/b/);
});

test("persistState message lands in vscode.setState (serializer revive source)", () => {
  const { persisted, post } = bootShell();
  const state = { sessionId: "s-1", cwd: "/repo", view: "chat" };
  post({ source: "host", payload: { kind: "persistState", state } });
  post({ source: "host", payload: { kind: "persistState" } }); // 无 state 不崩
  assert.deepEqual(persisted, [state]);
});

test("serverError paints the failure gate and bumps gen", async () => {
  const { gate, gateText, post } = bootShell();
  post({ source: "host", payload: { kind: "serverError", text: "boom" } });
  assert.ok(gate.classList.contains("error"));
  assert.equal(gateText.innerHTML, "boom");
});

test("probe timeout falls back to failure page after deadline", async () => {
  const { window, posted, gate, gateText, post } = bootShell({
    fetchImpl: async () => {
      // 第一次探测失败后把假时钟推到 90s 之后，loop 下一次检查即退出
      window.Date.now = () => Date.now() + 120000;
      throw new Error("ECONNREFUSED");
    },
  });
  post({
    source: "host",
    payload: { kind: "serverReady", url: "http://127.0.0.1:9/", probe: "http://127.0.0.1:9/api/embed" },
  });
  await delay(1800); // 一次 fetch 拒绝 + 1.5s 重试间隔
  assert.ok(gate.classList.contains("error"));
  assert.match(gateText.innerHTML, /Cannot reach/);
  assert.match(gateText.innerHTML, /restart the IDE/, "browser-side wedges need a restart hint");
  assert.ok(posted.some((m) => m.text === "90s probe timeout, showing failure page"));
});

test("offline fallback self-heals: re-probe then re-navigates", async () => {
  const { posted, gate, frame, post, window } = bootShell();
  post({
    source: "host",
    payload: { kind: "serverReady", url: "http://127.0.0.1:3031/", probe: "http://127.0.0.1:3031/" },
  });
  await delay(20);
  frame.dispatchEvent(new window.Event("load"));
  // iframe 导航落到 SW 兜底页——offline.html 主动回报
  post({ source: "pi-web-offline" });
  assert.equal(frame.style.display, "none");
  assert.equal(gate.style.display, "grid");
  assert.ok(posted.some((m) => /^iframe landed on offline fallback, re-probing/.test(m.text)));
  // 探测恢复 → 重新赋 src；同 URL 的 serverReady 判重不得吞掉这轮重探
  await delay(20);
  assert.equal(
    posted.filter((m) => m.text === "server probe passed, setting iframe.src").length,
    2,
  );
  // 新文档正常落地 → 收门（offlineShown 不能带到新文档的 load 判定）
  frame.dispatchEvent(new window.Event("load"));
  assert.equal(gate.style.display, "none");
  assert.equal(frame.style.display, "block");
});

test("offline fallback: same-URL serverReady is not deduped while offline shown", async () => {
  const { posted, post } = bootShell();
  const payload = { kind: "serverReady", url: "http://127.0.0.1:3031/", probe: "http://127.0.0.1:3031/" };
  post({ source: "host", payload });
  await delay(20);
  post({ source: "pi-web-offline" });
  // offlineShown 为真期间，同 URL 重推必须照常重探——用户再点同一会话
  // 时的恢复臂；同步到达保证命中兜底态而非自愈重探后的在飞态。
  post({ source: "host", payload });
  await delay(20);
  assert.ok(
    posted.filter((m) => m.text === "server probe passed, setting iframe.src").length >= 2,
  );
});

test("offline fallback surfaces the retry counter on the gate", async () => {
  // 每轮兜底→重探→再导航要在门上可见进度——8s 挂起期间 Connecting
  // 文案必须带计数，用户不该盲等 3 次重试。
  const { gateText, frame, post, window } = bootShell();
  post({
    source: "host",
    payload: { kind: "serverReady", url: "http://127.0.0.1:3031/", probe: "x" },
  });
  await delay(20);
  post({ source: "pi-web-offline" });
  await delay(20); // 探测过 → showFrame：Connecting 带第 1 轮计数
  assert.match(gateText.innerHTML, /retry 1 of 3/);
  post({ source: "pi-web-offline" });
  await delay(20);
  assert.match(gateText.innerHTML, /retry 2 of 3/);
  // 成功落地后计数复位——下一次正常连接的 Connecting 不带 retry 尾标
  frame.dispatchEvent(new window.Event("load"));
  post({
    source: "host",
    payload: { kind: "serverReady", url: "http://127.0.0.1:3031/other", probe: "x" },
  });
  await delay(20);
  assert.match(gateText.innerHTML, /Connecting to local server/);
  assert.ok(!gateText.innerHTML.includes("retry"), "counter must reset after a clean load");
});

test("offline fallback exhausts retries into the failure gate", async () => {
  // 服务恒活（探测总过）但每次导航都落兜底页——重试上限后转错误门，
  // 防服务真死/SW 坏态下兜底→重探→兜底无限空转。
  const { gate, gateText, post } = bootShell();
  post({
    source: "host",
    payload: { kind: "serverReady", url: "http://127.0.0.1:3031/", probe: "x" },
  });
  await delay(20);
  for (let i = 0; i < 4; i++) {
    post({ source: "pi-web-offline" });
    await delay(20);
  }
  assert.ok(gate.classList.contains("error"));
  assert.match(gateText.innerHTML, /Cannot reach/);
  assert.match(gateText.innerHTML, /restart the IDE/, "browser-side wedges need a restart hint");
});

test("serverReady after an error recovers (new probe generation)", async () => {
  const { gate, frame, post } = bootShell();
  post({ source: "host", payload: { kind: "serverError", text: "down" } });
  assert.ok(gate.classList.contains("error"));
  post({
    source: "host",
    payload: { kind: "serverReady", url: "http://127.0.0.1:3031/", probe: "x" },
  });
  await delay(20);
  assert.ok(!gate.classList.contains("error"));
  assert.match(String(frame.src), /127\.0\.0\.1:3031/);
});

test("embed envelope forwards to host; host envelope forwards into iframe", async () => {
  const { posted, frame, post } = bootShell();
  post({ source: "embed", id: "r1", request: { kind: "readFile" } });
  // MessageEvent 结构化克隆——按字段断言而非引用
  assert.equal(posted.at(-1).source, "embed");
  assert.equal(posted.at(-1).id, "r1");

  let received = null;
  frame.contentWindow.addEventListener("message", (e) => (received = e.data));
  post({ source: "host", payload: { kind: "response", id: "r1", response: { ok: 1 } } });
  await delay(10); // jsdom iframe.contentWindow 投递是异步的
  assert.equal(received?.source, "host");
  assert.equal(received?.payload.id, "r1");
});
