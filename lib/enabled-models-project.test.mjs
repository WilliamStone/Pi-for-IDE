import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const {
  projectSeedPatterns,
  projectSettingsPath,
  readProjectSettingsStatus,
  writeProjectEnabledModels,
} = await jiti.import("./enabled-models-project.ts");

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-project-scope-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const settingsJson = (dir) => join(dir, ".pi", "settings.json");

test("status tells absent, parseable and corrupt files apart", async () => {
  await withTempDir(async (dir) => {
    assert.equal(readProjectSettingsStatus(dir), "absent");

    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(settingsJson(dir), JSON.stringify({ theme: "dark" }));
    assert.equal(readProjectSettingsStatus(dir), "ok");

    await writeFile(settingsJson(dir), "{ not json");
    assert.equal(readProjectSettingsStatus(dir), "corrupt");

    // A syntactically valid file that is not an object is just as unwritable.
    await writeFile(settingsJson(dir), "[1, 2]");
    assert.equal(readProjectSettingsStatus(dir), "corrupt");
  });
});

test("the project settings path lives under .pi/", async () => {
  await withTempDir(async (dir) => {
    assert.equal(projectSettingsPath(dir), settingsJson(dir));
  });
});

test("writing creates the file, preserves other keys, and drops the key on undefined", async () => {
  await withTempDir(async (dir) => {
    // Missing file and missing .pi/ directory are both created.
    writeProjectEnabledModels(dir, ["anthropic/*"]);
    assert.deepEqual(JSON.parse(await readFile(settingsJson(dir), "utf8")), {
      enabledModels: ["anthropic/*"],
    });

    // Other keys — including ones pi-web does not know — survive the write.
    await writeFile(settingsJson(dir), JSON.stringify({ theme: "dark", retry: { enabled: true } }));
    writeProjectEnabledModels(dir, ["openai/*", "anthropic/claude:high"]);
    assert.deepEqual(JSON.parse(await readFile(settingsJson(dir), "utf8")), {
      theme: "dark",
      retry: { enabled: true },
      enabledModels: ["openai/*", "anthropic/claude:high"],
    });

    // undefined removes only the key — the project falls back to global.
    writeProjectEnabledModels(dir, undefined);
    assert.deepEqual(JSON.parse(await readFile(settingsJson(dir), "utf8")), {
      theme: "dark",
      retry: { enabled: true },
    });
  });
});

test("writing into a corrupt file fails instead of losing it", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(settingsJson(dir), "{ not json");
    assert.throws(() => writeProjectEnabledModels(dir, ["openai/*"]));
    assert.equal(await readFile(settingsJson(dir), "utf8"), "{ not json");
  });
});

test("the seed copies a defined list verbatim, pins and globs included", () => {
  const input = { patterns: ["anthropic/*:high", "openai/gpt-5"], availableRefs: [], resolutions: [] };
  const seed = projectSeedPatterns(input);
  assert.deepEqual(seed, ["anthropic/*:high", "openai/gpt-5"]);
  assert.notEqual(seed, input.patterns);
});

test("an unscoped seed prefers verified globs and falls back to references", () => {
  const input = {
    patterns: undefined,
    availableRefs: ["anthropic/a", "anthropic/b", "local/m1"],
    resolutions: [],
    providerGlobs: { anthropic: "anthropic/*" },
  };
  assert.deepEqual(projectSeedPatterns(input), ["anthropic/*", "local/m1"]);
});
