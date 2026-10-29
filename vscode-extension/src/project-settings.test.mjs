import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";

// project-settings.ts imports "vscode" — redirect to the shared stub
// (same registerHooks pattern as bridge.test.mjs).
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "vscode") {
      return {
        url: new URL("./test-vscode-stub.mjs", import.meta.url).href,
        shortCircuit: true,
      };
    }
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.(mjs|cjs|js|ts|json)$/.test(specifier)
    ) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

const { calls, workspace } = await import("./test-vscode-stub.mjs");
const { projectSettingsFile, PROJECT_SETTINGS_SKELETON, openProjectSettings } =
  await import("./project-settings.ts");

function tmp() {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-proj-settings-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("projectSettingsFile resolves <dir>/.pi/settings.json (strict per-cwd)", () => {
  const dir = path.join("x", "proj");
  assert.equal(
    projectSettingsFile(dir),
    path.join(dir, ".pi", "settings.json"),
  );
});

test("skeleton is valid JSON carrying zero override keys", () => {
  const parsed = JSON.parse(PROJECT_SETTINGS_SKELETON);
  assert.deepEqual(parsed, {}, "skeleton must not seed any key — a defined key silently becomes a project override on save");
});

test("absent file → path-bound untitled doc, skeleton inserted, no disk write", async () => {
  const { dir, cleanup } = tmp();
  try {
    calls.openTextDocument.length = 0;
    calls.showTextDocument.length = 0;
    calls.appliedEdits.length = 0;
    await openProjectSettings(dir);
    assert.equal(calls.openTextDocument.length, 1);
    const uri = calls.openTextDocument[0];
    assert.equal(uri.scheme, "untitled", "deferred create must be an untitled doc bound to the target path");
    assert.equal(uri.fsPath, projectSettingsFile(dir));
    // 骨架经 WorkspaceEdit 在显示前注入（showTextDocument 前 applyEdit
    // 必须已记录——否则 Ctrl+S 可抢在注入前落出空文件）。
    assert.equal(calls.appliedEdits.length, 1);
    const insert = calls.appliedEdits[0].ops.find((op) => op.kind === "insert");
    assert.equal(insert.text, PROJECT_SETTINGS_SKELETON);
    assert.equal(insert.uri.fsPath, projectSettingsFile(dir));
    assert.equal(calls.showTextDocument.length, 1);
    // 关键不变式：打开动作不碰磁盘——文件仍不存在，保存才落盘。
    assert.ok(!existsSync(projectSettingsFile(dir)));
  } finally {
    cleanup();
  }
});

test("pending unsaved untitled → re-invoke only activates, never re-inserts", async () => {
  const { dir, cleanup } = tmp();
  try {
    // 磁盘无文件但编辑器里已有绑定同路径的未保存 untitled——
    // existsSync 看不见它，漏判会把第二副骨架插进同一文档。
    const pending = { uri: { scheme: "untitled", fsPath: projectSettingsFile(dir) } };
    workspace.textDocuments.push(pending);
    try {
      calls.openTextDocument.length = 0;
      calls.showTextDocument.length = 0;
      calls.appliedEdits.length = 0;
      await openProjectSettings(dir);
      assert.equal(calls.openTextDocument.length, 0, "pending doc must be reused, not reopened");
      assert.equal(calls.appliedEdits.length, 0, "activate-only — a second skeleton would corrupt the doc on save");
      assert.equal(calls.showTextDocument.length, 1);
      assert.equal(calls.showTextDocument[0].doc, pending);
    } finally {
      workspace.textDocuments.length = 0;
    }
  } finally {
    cleanup();
  }
});

test("existing file → opens the file directly, no untitled doc", async () => {
  const { dir, cleanup } = tmp();
  try {
    const file = projectSettingsFile(dir);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"packages":[]}\n', "utf8");
    calls.openTextDocument.length = 0;
    calls.showTextDocument.length = 0;
    await openProjectSettings(dir);
    assert.equal(calls.openTextDocument.length, 0);
    assert.equal(calls.showTextDocument.length, 1);
    assert.equal(calls.showTextDocument[0].doc.scheme, "file");
    assert.equal(calls.showTextDocument[0].doc.fsPath, file);
  } finally {
    cleanup();
  }
});

