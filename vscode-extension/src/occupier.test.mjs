import assert from "node:assert/strict";
import test from "node:test";
import { classifyOccupier } from "./occupier.ts";

test("classifyOccupier: default scoped package → ours", () => {
  assert.equal(
    classifyOccupier(String.raw`node C:\Users\x\npm\node_modules\@william_stone\pi-web-for-ide\bin\pi-web.js`),
    "ours",
  );
  // 托管运行时版本目录路径（无 scope 字面量也命中 runtime\node_modules）
  assert.equal(
    classifyOccupier(String.raw`node C:\gs\runtime\versions\0.12.2\node_modules\@william_stone\pi-web-for-ide\bin\pi-web.js`),
    "ours",
  );
});

test("classifyOccupier: unscoped fork package → unscoped", () => {
  assert.equal(
    classifyOccupier(String.raw`node C:\npm\node_modules\pi-web-for-ide\bin\pi-web.js`),
    "unscoped",
  );
});

test("classifyOccupier: upstream pi-web → upstream", () => {
  assert.equal(
    classifyOccupier(String.raw`node C:\npm\node_modules\pi-web\bin\pi-web.js`),
    "upstream",
  );
});

test("classifyOccupier: _npx residue → legacy-npx", () => {
  assert.equal(
    classifyOccupier(String.raw`node C:\npm-cache\_npx\abc123\node_modules\pi-web-for-ide\bin\pi-web.js`),
    "legacy-npx",
  );
});

test("classifyOccupier: unrelated cmdline → unknown", () => {
  assert.equal(classifyOccupier("code --serve-web"), "unknown");
  assert.equal(classifyOccupier(""), "unknown");
});

test("classifyOccupier: honors a custom configured package name", () => {
  // 自定义包 @acme/pi-web-acme 的全局安装应归 "ours"
  assert.equal(
    classifyOccupier(
      String.raw`node C:\npm\node_modules\@acme\pi-web-acme\bin\pi-web.js`,
      "@acme/pi-web-acme",
    ),
    "ours",
  );
  // 同包名但无 scope 目录 → unscoped
  assert.equal(
    classifyOccupier(
      String.raw`node C:\npm\node_modules\pi-web-acme\bin\pi-web.js`,
      "@acme/pi-web-acme",
    ),
    "unscoped",
  );
});
