import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { modelRefProvider, type EnabledModelsInput } from "./enabled-models";

/**
 * Project-scope `enabledModels`, a pi-web addition on top of pi's global-only
 * writer (`SettingsManager.setEnabledModels` writes `~/.pi/agent/settings.json`;
 * its project-scope counterpart is private). Everything here works directly on
 * `<cwd>/${CONFIG_DIR_NAME}/settings.json`: the file may be shared with pi's
 * TUI and committed to the repo, so edits preserve every other key verbatim.
 *
 * Reads are kept apart from the SettingsManager: a file that fails to parse is
 * reported as "corrupt" rather than read as empty, because writing into a file
 * the user broke by hand would either fail or silently lose their content.
 */

export type ProjectSettingsFileStatus = "absent" | "ok" | "corrupt";

export function projectSettingsPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "settings.json");
}

export function readProjectSettingsStatus(cwd: string): ProjectSettingsFileStatus {
  const path = projectSettingsPath(cwd);
  if (!existsSync(path)) return "absent";
  try {
    const parsed = parseProjectSettingsFile(path);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? "ok" : "corrupt";
  } catch {
    return "corrupt";
  }
}

function parseProjectSettingsFile(path: string): unknown {
  const text = readFileSync(path, "utf8");
  return JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
}

/**
 * Set or remove (patterns === undefined) the `enabledModels` key. Other keys —
 * and therefore project settings pi-web knows nothing about — survive.
 *
 * The write is synchronous, so it is atomic within this process. Across
 * processes (a pi TUI saving at the same moment) the last writer wins — the
 * same exposure the TUI accepts for hand-edited files, and not worth a lock
 * dependency for a key this rarely touched.
 */
export function writeProjectEnabledModels(cwd: string, patterns: string[] | undefined): void {
  const path = projectSettingsPath(cwd);
  let settings: Record<string, unknown> = {};
  if (existsSync(path)) {
    const parsed = parseProjectSettingsFile(path);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Cannot parse project settings: ${path}`);
    }
    settings = parsed as Record<string, unknown>;
  }
  if (patterns === undefined) delete settings.enabledModels;
  else settings.enabledModels = patterns;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2), "utf8");
}

/**
 * Patterns for a freshly created project scope: what the user already sees.
 *
 * A defined (global) pattern list is copied verbatim — user-authored globs and
 * `:level` thinking pins included. When nothing is configured (all enabled)
 * each provider contributes its verified glob (`provider/*` or the wider
 * candidate that resolves to exactly its models), falling back to explicit
 * references where no glob verifies — the same shape `materializeEntries`
 * writes, so models added later stay enabled instead of freezing the list.
 */
export function projectSeedPatterns(input: EnabledModelsInput): string[] {
  if (input.patterns !== undefined) return [...input.patterns];
  const seeds: string[] = [];
  const providers = [...new Set(input.availableRefs.map(modelRefProvider))];
  for (const provider of providers) {
    const glob = input.providerGlobs?.[provider];
    if (glob) seeds.push(glob);
    else seeds.push(...input.availableRefs.filter((ref) => modelRefProvider(ref) === provider));
  }
  return seeds;
}
