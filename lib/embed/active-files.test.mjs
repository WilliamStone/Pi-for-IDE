import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createActiveFilesExtension, stripActiveFilesHint, ACTIVE_FILES_EXTENSION_NAME } =
  await jiti.import("./active-files.ts");

function loadHandlers(extension) {
  const handlers = new Map();
  extension.factory({
    on: (event, handler) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  });
  return handlers;
}

test("appends the active-files section to the projected system prompt", async () => {
  const ext = createActiveFilesExtension(() => ["src/a.ts", "src/b.ts"]);
  assert.equal(ext.name, ACTIVE_FILES_EXTENSION_NAME);
  assert.equal(ext.hidden, true);
  const handlers = loadHandlers(ext);
  const handler = handlers.get("before_agent_start");
  const out = await handler({ type: "before_agent_start", prompt: "hi", systemPrompt: "Pi sections" });
  assert.match(out.systemPrompt, /Pi sections/);
  assert.match(out.systemPrompt, /pi-web:active-files/);
  assert.match(out.systemPrompt, /src\/a\.ts/);
  assert.match(out.systemPrompt, /src\/b\.ts/);
});

test("no active files → leaves the projection untouched", async () => {
  const handlers = loadHandlers(createActiveFilesExtension(() => undefined));
  const handler = handlers.get("before_agent_start");
  assert.equal(await handler({ type: "before_agent_start", prompt: "hi", systemPrompt: "P" }), undefined);
  const handlers2 = loadHandlers(createActiveFilesExtension(() => []));
  assert.equal(await handlers2.get("before_agent_start")({ systemPrompt: "P" }), undefined);
});

test("strips a previous injected block before appending (transcript replay)", async () => {
  let files = ["old.ts"];
  const handler = loadHandlers(createActiveFilesExtension(() => files)).get("before_agent_start");
  const first = await handler({ systemPrompt: "P" });
  // 上一轮投影被 transcript 回放后，下一轮先剥旧段再拼新段——不叠两份。
  files = ["new.ts"];
  const second = await handler({ systemPrompt: first.systemPrompt });
  assert.equal((second.systemPrompt.match(/<!-- pi-web:active-files -->/g) ?? []).length, 1);
  assert.doesNotMatch(second.systemPrompt, /old\.ts/);
  assert.match(second.systemPrompt, /new\.ts/);
});

test("stripActiveFilesHint removes only the injected block", () => {
  const wrapped = `HEAD\n\n<!-- pi-web:active-files -->\nfiles\n<!-- /pi-web:active-files -->\nTAIL`;
  assert.equal(stripActiveFilesHint(wrapped), "HEAD\nTAIL");
  assert.equal(stripActiveFilesHint("no markers"), "no markers");
});
