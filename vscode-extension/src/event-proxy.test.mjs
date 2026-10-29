import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

// 仓库 .ts 不带扩展名的相对 import → 补 .ts 让 strip-types 直跑。
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier.startsWith("./") &&
      !specifier.endsWith(".ts") &&
      !specifier.endsWith(".mjs")
    ) {
      return { url: new URL(specifier + ".ts", context.parentURL).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { EventSourceProxy } = await import("./event-proxy.ts");

/** 假传输：记录请求，手动触发 response/data/end/error。 */
function makeTransport() {
  const calls = [];
  return {
    calls,
    transport: (opts) => {
      const req = { opts, destroyed: false, destroy() { this.destroyed = true; } };
      calls.push(req);
      return req;
    },
    respond(req, status = 200, location) {
      const handlers = {};
      const res = {
        status,
        location,
        on: (ev, cb) => { (handlers[ev] ??= []).push(cb); },
        resume: () => {},
      };
      req.opts.onResponse(res);
      res.data = (chunk) => handlers.data?.forEach((cb) => cb(Buffer.from(chunk)));
      res.end = () => handlers.end?.forEach((cb) => cb());
      res.fail = (e) => handlers.error?.forEach((cb) => cb(e));
      return res;
    },
  };
}

function makeProxy() {
  const posted = [];
  const logs = [];
  const t = makeTransport();
  const proxy = new EventSourceProxy({
    post: (p) => posted.push(p),
    log: (l) => logs.push(l),
    transport: t.transport,
  });
  return { proxy, posted, logs, t };
}

test("open → transport 建连（含 Last-Event-ID）；数据/结束泵回页面", () => {
  const { proxy, posted, t } = makeProxy();
  proxy.open({ streamId: "es1", url: "http://h/api/events", lastEventId: "9", pageId: "p" });
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].opts.headers["Last-Event-ID"], "9");
  assert.equal(t.calls[0].opts.headers["Accept-Encoding"], "identity");

  const res = t.respond(t.calls[0], 200);
  assert.deepEqual(posted[0], { kind: "eventSourceOpen", streamId: "es1", status: 200 });
  res.data("data: hello\n\n");
  assert.deepEqual(posted[1], { kind: "eventSourceData", streamId: "es1", chunk: "data: hello\n\n" });
  res.end();
  assert.deepEqual(posted[2], { kind: "eventSourceEnd", streamId: "es1" });
});

test("HTTP 非 2xx → open{status} + end{error}，无数据转发", () => {
  const { proxy, posted, t } = makeProxy();
  proxy.open({ streamId: "es1", url: "http://h/x" });
  const res = t.respond(t.calls[0], 503);
  res.data("ignored");
  assert.deepEqual(posted, [
    { kind: "eventSourceOpen", streamId: "es1", status: 503 },
    { kind: "eventSourceEnd", streamId: "es1", error: "HTTP 503" },
  ]);
});

test("init → 清掉旧代全部流；旧代 open 被丢", () => {
  const { proxy, t, logs } = makeProxy();
  proxy.open({ streamId: "es1", url: "http://h/a", pageId: "old" });
  proxy.init("new");
  assert.ok(t.calls[0].destroyed);
  assert.ok(logs.some((l) => l.includes("page reloaded")));

  proxy.open({ streamId: "es2", url: "http://h/b", pageId: "old" }); // 旧代迟到
  assert.equal(t.calls.length, 1); // 没建连
  proxy.open({ streamId: "es3", url: "http://h/c", pageId: "new" });
  assert.equal(t.calls.length, 2);
});

test("close → destroy，不再回投 end", () => {
  const { proxy, posted, t } = makeProxy();
  proxy.open({ streamId: "es1", url: "http://h/a" });
  proxy.close({ streamId: "es1" });
  assert.ok(t.calls[0].destroyed);
  const res = t.respond(t.calls[0], 200);
  res.end();
  assert.equal(posted.length, 0); // abort 后静默
});

test("同 streamId 重复 open → 旧流被替换", () => {
  const { proxy, t, logs } = makeProxy();
  proxy.open({ streamId: "es1", url: "http://h/a" });
  proxy.open({ streamId: "es1", url: "http://h/b" });
  assert.ok(t.calls[0].destroyed);
  assert.equal(t.calls[1].opts.url, "http://h/b");
  assert.ok(logs.some((l) => l.includes("replaced")));
});

test("302 → 跟随重定向重建流", () => {
  const { proxy, posted, t } = makeProxy();
  proxy.open({ streamId: "es1", url: "http://h/old" });
  t.respond(t.calls[0], 302, "/new");
  assert.equal(t.calls.length, 2);
  assert.equal(t.calls[1].opts.url, "http://h/new");
  t.respond(t.calls[1], 200);
  assert.deepEqual(posted[0], { kind: "eventSourceOpen", streamId: "es1", status: 200 });
});

test("传输层 error → eventSourceEnd{error}", () => {
  const { proxy, posted, t } = makeProxy();
  proxy.open({ streamId: "es1", url: "http://h/a" });
  t.calls[0].opts.onError(new Error("ECONNREFUSED"));
  assert.equal(posted[0].kind, "eventSourceEnd");
  assert.ok(String(posted[0].error).includes("ECONNREFUSED"));
});

test("dispose → 全部流 abort", () => {
  const { proxy, t } = makeProxy();
  proxy.open({ streamId: "es1", url: "http://h/a" });
  proxy.open({ streamId: "es2", url: "http://h/b" });
  proxy.dispose();
  assert.ok(t.calls[0].destroyed && t.calls[1].destroyed);
});
