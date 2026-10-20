import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

const { noteServerBoot, SERVER_RESTARTED_EVENT } = await import("./boot-watch.ts");

const spy = () => {
  const events = [];
  return { events, dispatch: (event) => events.push(event) };
};

beforeEach(() => {
  delete globalThis.__piWebBoot;
});

test("the first boot pins the instance without firing", () => {
  const { events, dispatch } = spy();
  noteServerBoot("boot-1", dispatch);
  assert.equal(events.length, 0);
  assert.equal(globalThis.__piWebBoot, "boot-1");
});

test("a different boot fires the restart event once", () => {
  const { events, dispatch } = spy();
  noteServerBoot("boot-1", dispatch);
  noteServerBoot("boot-2", dispatch);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, SERVER_RESTARTED_EVENT);
  noteServerBoot("boot-2", dispatch);
  assert.equal(events.length, 1);
});

test("a third swap fires again; missing boot is ignored", () => {
  const { events, dispatch } = spy();
  noteServerBoot("a", dispatch);
  noteServerBoot(undefined, dispatch);
  noteServerBoot("", dispatch);
  noteServerBoot(null, dispatch);
  assert.equal(events.length, 0);
  noteServerBoot("b", dispatch);
  assert.equal(events.length, 1);
});
