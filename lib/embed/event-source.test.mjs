import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

// 仓库 .ts 不带扩展名的相对 import → 补 .ts 让 strip-types 直跑。
registerHooks({
  resolve(specifier, context, next) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !specifier.endsWith(".ts") &&
      !specifier.endsWith(".mjs")
    ) {
      return { url: new URL(specifier + ".ts", context.parentURL).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { createProxiedEventSourceClass } = await import("./event-source.ts");

/** 桩 bridge：记录外发请求、暴露宿→页通知注入口。 */
function makeDeps() {
  const sent = [];
  let listener = null;
  return {
    sent,
    deps: {
      pageId: "p1",
      notify: (req) => sent.push(req),
      subscribe: (l) => {
        listener = l;
        return () => {};
      },
    },
    emit(payload) {
      listener?.(payload);
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("open → host status 200 → readyState OPEN + open 事件", () => {
  const h = makeDeps();
  const ES = createProxiedEventSourceClass(h.deps);
  const es = new ES("http://h/api/events");
  const events = [];
  es.addEventListener("open", (e) => events.push(e.type));

  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].kind, "eventSourceOpen");
  assert.equal(h.sent[0].url, "http://h/api/events");
  assert.equal(h.sent[0].pageId, "p1");
  const streamId = h.sent[0].streamId;

  h.emit({ kind: "eventSourceOpen", streamId, status: 200 });
  assert.equal(es.readyState, 1);
  assert.deepEqual(events, ["open"]);
});

test("data 分块解析：多行 data 拼接、具名 event 按类型派发、lastEventId 生效", () => {
  const h = makeDeps();
  const ES = createProxiedEventSourceClass(h.deps);
  const es = new ES("http://h/s");
  const streamId = h.sent[0].streamId;
  h.emit({ kind: "eventSourceOpen", streamId, status: 200 });

  const messages = [];
  const named = [];
  es.onmessage = (e) => messages.push(e.data);
  es.addEventListener("change", (e) => named.push([e.data, e.lastEventId]));

  // 跨块断行 + 注释行 + 具名事件 + id 字段
  h.emit({ kind: "eventSourceData", streamId, chunk: ":keep-alive\nevent: change\nid: 42\nda" });
  h.emit({ kind: "eventSourceData", streamId, chunk: "ta: {\"a\":1}\ndata: line2\n\n" });
  assert.deepEqual(named, [['{"a":1}\nline2', "42"]]);

  h.emit({ kind: "eventSourceData", streamId, chunk: "data: plain\n\n" });
  assert.deepEqual(messages, ["plain"]);
});

test("断流 → error 事件 + 按 retry: 间隔重连并带 Last-Event-ID", async () => {
  const h = makeDeps();
  const ES = createProxiedEventSourceClass(h.deps);
  const es = new ES("http://h/s");
  const streamId = h.sent[0].streamId;
  h.emit({ kind: "eventSourceOpen", streamId, status: 200 });
  h.emit({ kind: "eventSourceData", streamId, chunk: "retry: 1\nid: 7\ndata: x\n\n" });

  const errors = [];
  es.onerror = () => errors.push("e");
  h.emit({ kind: "eventSourceEnd", streamId });
  assert.equal(es.readyState, 0); // CONNECTING
  assert.deepEqual(errors, ["e"]);

  await sleep(20);
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].kind, "eventSourceOpen");
  assert.equal(h.sent[1].streamId, streamId); // 同 streamId 重连
  assert.equal(h.sent[1].lastEventId, "7");
});

test("HTTP 非 2xx → CLOSED + error，不重连", async () => {
  const h = makeDeps();
  const ES = createProxiedEventSourceClass(h.deps);
  const es = new ES("http://h/s");
  const streamId = h.sent[0].streamId;
  h.emit({ kind: "eventSourceOpen", streamId, status: 503 });
  assert.equal(es.readyState, 2);
  h.emit({ kind: "eventSourceEnd", streamId, error: "HTTP 503" });
  await sleep(10);
  assert.equal(h.sent.length, 1); // 没有重连 open
});

test("close() → CLOSED + eventSourceClose 通知；迟到的数据被丢弃", () => {
  const h = makeDeps();
  const ES = createProxiedEventSourceClass(h.deps);
  const es = new ES("http://h/s");
  const streamId = h.sent[0].streamId;
  h.emit({ kind: "eventSourceOpen", streamId, status: 200 });

  let got = 0;
  es.onmessage = () => got++;
  es.close();
  assert.equal(es.readyState, 2);
  assert.equal(h.sent.at(-1).kind, "eventSourceClose");

  h.emit({ kind: "eventSourceData", streamId, chunk: "data: x\n\n" });
  h.emit({ kind: "eventSourceEnd", streamId });
  assert.equal(got, 0);
});

test("close() 在 end 前调用 → 不再重连", async () => {
  const h = makeDeps();
  const ES = createProxiedEventSourceClass(h.deps);
  const es = new ES("http://h/s");
  h.emit({ kind: "eventSourceData", streamId: h.sent[0].streamId, chunk: "retry: 1\n\n" });
  es.close();
  await sleep(10);
  assert.equal(h.sent.filter((r) => r.kind === "eventSourceOpen").length, 1);
});
