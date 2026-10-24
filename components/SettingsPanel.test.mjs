import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
const loginSource = await readFile(new URL("../app/login/page.tsx", import.meta.url), "utf8");
const panelSource = await readFile(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");

test("the trust dialog Settings › MCP opens stacks above Settings", () => {
  const zIndex = (selector) => Number(cssSource.match(new RegExp(`\\${selector} \\{[^}]*z-index: (\\d+);`))?.[1]);
  assert.ok(zIndex(".project-trust-backdrop") > zIndex(".settings-dialog-backdrop"));
});

test("the login page returns only to a destination safeLoginDestination() accepts", () => {
  assert.match(loginSource, /safeLoginDestination\(destination, window\.location\.origin\)/);
});

// Pinned (?view=settings) renders the surface as the page itself: no dialog
// chrome (title/close/Escape/modal semantics), but the same tabs and content.
test("pinned settings drop the dialog frame and close affordances", () => {
  assert.match(panelSource, /role=\{pinned \? undefined : "dialog"\}/);
  assert.match(panelSource, /aria-modal=\{pinned \? undefined : true\}/);
  assert.match(panelSource, /settings-dialog-backdrop\$\{pinned \? " settings-dialog-backdrop--bare"/);
  assert.match(panelSource, /settings-dialog-surface\$\{pinned \? " settings-dialog-surface--bare"/);
  assert.match(panelSource, /\{!pinned && <strong className="settings-dialog-title">/);
  assert.match(panelSource, /\{!pinned && <button[^]*?settings-dialog-close/);
  // Embedded pages must not close on backdrop click or Escape.
  assert.match(panelSource, /!pinned && event\.target === event\.currentTarget/);
  assert.match(panelSource, /pinned \? \(\) => \{\} : listenForPanelEscape/);
});

test("the bare settings surface fills the viewport without dialog chrome", () => {
  const surface = cssSource.match(/\.settings-dialog-surface--bare \{([^}]*)\}/)?.[1] ?? "";
  for (const prop of ["width: 100%", "height: 100%", "border: none", "border-radius: 0", "box-shadow: none"]) {
    assert.ok(surface.includes(prop), `bare surface missing "${prop}"`);
  }
  // The backdrop stops being a dimming overlay and becomes the page itself.
  assert.match(cssSource, /\.settings-dialog-backdrop--bare \{[^}]*background: var\(--bg\)/);
  // No close button → the header stops reserving space for one.
  assert.match(cssSource, /\.settings-dialog-backdrop--bare \.settings-dialog-header \{\s*padding-right: 18px/);
});
