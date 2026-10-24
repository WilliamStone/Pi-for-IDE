import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

// ?view=settings is a chat-only shell hosting the pinned settings page: the
// session sidebar and the conversation top bar both belong to chat, not here.
test("view=settings hides the sidebar (chatOnly) and the conversation top bar", () => {
  assert.match(source, /const settingsView = embedView\(\) === "settings"/);
  assert.match(source, /chatOnlyView = embedView\(\) === "chat" \|\| settingsView/);
  assert.match(source, /settingsView \? \{ display: "none" \}/);
});

test("view=settings mounts SettingsPanel pinned so the bare shell applies", () => {
  assert.match(source, /pinned=\{settingsView\}/);
});

test("view=settings deep-links a section via the ?section= entry param", () => {
  assert.match(source, /embedParam\("section"\)/);
  assert.match(source, /initialSection=\{settingsSection\}/);
});
