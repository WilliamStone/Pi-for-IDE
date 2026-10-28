import { stat } from "fs/promises";
import { join, resolve } from "path";
import { getAgentDir, SettingsManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  clearEnabledModels,
  constrainProviderEntries,
  pruneStaleEnabledModels,
  renameModelPatterns,
  renameProviderPatterns,
  setModelsEnabled,
  type EnabledModelsEdit,
  type ProviderRename,
} from "@/lib/enabled-models";
import {
  buildEnabledModelsInput,
  buildEnabledModelsView,
  customProviderIds,
  displaySettingsPath,
  modelRef,
  readEnabledModelsSettings,
  writeEnabledModels,
  type EnabledModelsView,
} from "@/lib/enabled-models-runtime";
import {
  projectSeedPatterns,
  projectSettingsPath,
  readProjectSettingsStatus,
  writeProjectEnabledModels,
  type ProjectSettingsFileStatus,
} from "@/lib/enabled-models-project";
import type { EnabledModelsInput } from "@/lib/enabled-models";
import { getModelRuntimeWithExtensions } from "@/lib/model-runtime";
import { withDeferredProviderModels } from "@/lib/deferred-provider-models";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { invalidateModelsCache } from "@/lib/models-cache";

export const dynamic = "force-dynamic";

interface RequestContext {
  modelRuntime: ModelRuntime;
  models: readonly Model<Api>[];
  settingsManager: SettingsManager;
  /** Where the two settings files live, for the banner to name one. */
  paths: { cwd: string; agentDir: string };
}

async function loadContext(cwd: string): Promise<RequestContext> {
  const modelRuntime = withDeferredProviderModels(await getModelRuntimeWithExtensions());
  const agentDir = getAgentDir();
  return {
    modelRuntime,
    models: await modelRuntime.getAvailable(),
    settingsManager: SettingsManager.create(cwd, agentDir),
    paths: { cwd, agentDir },
  };
}

type EditScope = "global" | "project";

/**
 * The settings both domains hold, read once per request.
 *
 * `hasProjectKey` tracks what the SettingsManager resolves — the same rule pi
 * applies when it merges settings — so it can never disagree with `scope`.
 * `projectFile` is the raw file's parse state, which a SettingsManager load
 * error would flatten to "empty": needed so a corrupt file is refused, not
 * silently overwritten by a create.
 */
interface ScopeState {
  globalPatterns: string[] | undefined;
  projectPatterns: string[] | undefined;
  effectiveScope: EditScope;
  hasProjectKey: boolean;
  projectFile: ProjectSettingsFileStatus;
}

function readScopeState(context: RequestContext): ScopeState {
  const { scope } = readEnabledModelsSettings(context.settingsManager, context.paths);
  const projectPatterns = context.settingsManager.getProjectSettings().enabledModels;
  return {
    globalPatterns: context.settingsManager.getGlobalSettings().enabledModels,
    projectPatterns,
    effectiveScope: scope,
    hasProjectKey: projectPatterns !== undefined,
    projectFile: readProjectSettingsStatus(context.paths.cwd),
  };
}

function pickEditScope(state: ScopeState, edit?: EditScope): EditScope {
  const wanted = edit ?? state.effectiveScope;
  return wanted === "project" && state.hasProjectKey && state.projectFile === "ok" ? "project" : "global";
}

async function buildView(context: RequestContext, edit?: EditScope): Promise<EnabledModelsView> {
  const state = readScopeState(context);
  const editScope = pickEditScope(state, edit);
  const patterns = editScope === "project" ? state.projectPatterns : state.globalPatterns;
  const input = await buildEnabledModelsInput(patterns, context.models);
  const providerNames = new Map(
    context.modelRuntime.getProviders().map((provider) => [provider.id, provider.name]),
  );
  const modelError = context.modelRuntime.getError();
  return buildEnabledModelsView({
    input,
    models: context.models,
    providerNames,
    customProviders: customProviderIds(context.modelRuntime),
    scope: state.effectiveScope,
    editScope,
    hasProjectKey: state.hasProjectKey,
    projectFile: state.projectFile,
    settingsPath: displaySettingsPath(editScope === "project"
      ? projectSettingsPath(context.paths.cwd)
      : join(context.paths.agentDir, "settings.json")),
    ...(modelError ? { modelError } : {}),
  });
}

/**
 * The settingsManager loaded before a project write still holds the file as it
 * was; swap in a fresh one so the view answers from the just-written state.
 */
function reloadSettings(context: RequestContext): RequestContext {
  return { ...context, settingsManager: SettingsManager.create(context.paths.cwd, context.paths.agentDir) };
}

/**
 * Resolve the cwd whose project settings the request reads — and, for the
 * project ops below, writes (`<cwd>/.pi/settings.json`). It goes through the
 * same allow-list as `/api/files`.
 */
async function resolveCwd(raw: string | null): Promise<{ cwd: string } | { error: Response }> {
  if (!raw) return { cwd: process.cwd() };
  const cwd = resolve(raw);
  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    return { error: Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 }) };
  }
  if (!cwdStat.isDirectory()) {
    return { error: Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 }) };
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return { error: Response.json({ error: "Access denied" }, { status: 403 }) };
  }
  return { cwd };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const resolved = await resolveCwd(url.searchParams.get("cwd"));
  if ("error" in resolved) return resolved.error;
  const edit = url.searchParams.get("edit");

  try {
    return Response.json(await buildView(
      await loadContext(resolved.cwd),
      edit === "project" || edit === "global" ? edit : undefined,
    ));
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

interface EnabledModelsRequest {
  cwd?: unknown;
  op?: unknown;
  provider?: unknown;
  refs?: unknown;
  renames?: unknown;
  modelRenames?: unknown;
  fullyEnabled?: unknown;
  enabled?: unknown;
  /** Write target for models/provider/clear/prune; response domain for resync. */
  scope?: unknown;
}

function renamePairs(value: unknown): ProviderRename[] | null {
  if (!Array.isArray(value)) return null;
  const renames: ProviderRename[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { from, to } = entry as Record<string, unknown>;
    if (typeof from !== "string" || typeof to !== "string" || !from || !to) return null;
    renames.push({ from, to });
  }
  return renames;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  return value as string[];
}

/**
 * Repair the stored patterns after models.json changed under the panel.
 *
 * A pattern's meaning depends on the catalog, and the catalog just moved: a
 * provider rename can make its glob reach into another provider (pi matches
 * patterns against the bare model id too, so `stepfun/*` also matches
 * `commandcode`'s `stepfun/Step-5-Preview`), and renaming a model to an id with
 * a slash drops it out of `provider/*` entirely. So re-resolve, cut entries
 * back to the provider their prefix names, and restore the providers that were
 * fully enabled before the save.
 */
async function resyncAfterModelsConfigSave(
  context: RequestContext,
  input: EnabledModelsInput,
  options: {
    renames: readonly ProviderRename[];
    modelRenames: readonly ProviderRename[];
    fullyEnabled: readonly string[];
  },
): Promise<EnabledModelsEdit> {
  const { renames, modelRenames, fullyEnabled } = options;
  const original = input.patterns;
  // Model references first: they still carry the old provider id, which the
  // provider rewrite below would otherwise have replaced already.
  const renamed = renameProviderPatterns(renameModelPatterns(original, modelRenames), renames);
  let current = renamed === original
    ? input
    : await buildEnabledModelsInput(renamed, context.models, { withProviderGlobs: true });

  const constrained = constrainProviderEntries(current);
  if (constrained.ok && constrained.changed) {
    current = await buildEnabledModelsInput(constrained.patterns, context.models, { withProviderGlobs: true });
  }

  // A provider that was fully enabled before the save stays fully enabled, even
  // when a model of it was renamed out of the glob that used to cover it.
  const refs = fullyEnabled
    .map((id) => renames.find((rename) => rename.from === id)?.to ?? id)
    .flatMap((id) => context.models.filter((model) => model.provider === id).map(modelRef));
  const edit = setModelsEnabled(current, refs, true);
  if (!edit.ok) return edit;
  return { ok: true, patterns: edit.patterns, changed: !samePatternList(edit.patterns, original) };
}

function samePatternList(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((pattern, index) => pattern === b[index]);
}

const VALID_OPS = new Set([
  "models", "provider", "clear", "prune", "resync",
  "project-create", "project-clear",
]);

export async function PUT(req: Request) {
  let body: EnabledModelsRequest;
  try {
    body = await req.json() as EnabledModelsRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const op = typeof body.op === "string" ? body.op : "";
  if (!VALID_OPS.has(op)) {
    return Response.json({ error: "Invalid op" }, { status: 400 });
  }
  if (op === "models" || op === "provider") {
    if (typeof body.enabled !== "boolean") {
      return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
    }
  }
  if (body.cwd !== undefined && typeof body.cwd !== "string") {
    return Response.json({ error: "Invalid cwd" }, { status: 400 });
  }
  if (body.scope !== undefined && body.scope !== "global" && body.scope !== "project") {
    return Response.json({ error: "Invalid scope" }, { status: 400 });
  }
  const targetScope: EditScope = body.scope === "project" ? "project" : "global";

  const resolved = await resolveCwd(typeof body.cwd === "string" ? body.cwd : null);
  if ("error" in resolved) return resolved.error;

  try {
    let context = await loadContext(resolved.cwd);
    const state = readScopeState(context);

    if (state.projectFile === "corrupt" && (op === "project-create" || op === "project-clear" || targetScope === "project")) {
      return Response.json(
        { error: "Project settings file cannot be parsed; fix it before managing project scope", reason: "project-corrupt" },
        { status: 409 },
      );
    }

    if (op === "project-create" || op === "project-clear") {
      if (op === "project-create") {
        if (state.hasProjectKey) {
          return Response.json(
            { error: "This project already has its own enabledModels", reason: "project-exists" },
            { status: 409 },
          );
        }
        // Seed with what the user sees now: the global list verbatim, or one
        // verified glob per provider when everything is enabled.
        const input = await buildEnabledModelsInput(state.globalPatterns, context.models, { withProviderGlobs: true });
        writeProjectEnabledModels(resolved.cwd, projectSeedPatterns(input));
      } else {
        // Removing a key that is not there is the state the caller asked for.
        if (state.hasProjectKey) writeProjectEnabledModels(resolved.cwd, undefined);
      }
      invalidateModelsCache();
      context = reloadSettings(context);
      return Response.json(await buildView(context, op === "project-create" ? "project" : "global"));
    }

    // A global write is always allowed — a project key only shadows it. Writing
    // the project domain requires its key, or the edit would change a file the
    // user never asked us to create.
    if (targetScope === "project" && !state.hasProjectKey) {
      return Response.json(
        { error: "This project has no enabledModels of its own; create it first", reason: "project-absent" },
        { status: 409 },
      );
    }

    const patterns = targetScope === "project" ? state.projectPatterns : state.globalPatterns;
    const input = await buildEnabledModelsInput(patterns, context.models, { withProviderGlobs: true });
    let edit;
    if (op === "clear") {
      // Clearing the project domain resolves to "no patterns", which removes
      // the key — the project falls back to global, same as project-clear.
      edit = clearEnabledModels(input);
    } else if (op === "prune") {
      edit = pruneStaleEnabledModels(input);
    } else if (op === "resync") {
      const renames = renamePairs(body.renames);
      const modelRenames = renamePairs(body.modelRenames ?? []);
      const fullyEnabled = stringArray(body.fullyEnabled ?? []);
      if (!renames || !modelRenames || !fullyEnabled) {
        return Response.json({ error: "Invalid resync payload" }, { status: 400 });
      }
      // resync repairs every settings file that holds patterns — the global
      // edit is the primary one whatever domain the panel happens to show,
      // and the project key gets the same pass when present.
      const globalInput = await buildEnabledModelsInput(state.globalPatterns, context.models, { withProviderGlobs: true });
      edit = await resyncAfterModelsConfigSave(context, globalInput, { renames, modelRenames, fullyEnabled });
      if (state.hasProjectKey) {
        const projectInput = await buildEnabledModelsInput(state.projectPatterns, context.models, { withProviderGlobs: true });
        const projectEdit = await resyncAfterModelsConfigSave(context, projectInput, { renames, modelRenames, fullyEnabled });
        if (projectEdit.ok && projectEdit.changed) {
          writeProjectEnabledModels(resolved.cwd, projectEdit.patterns);
          context = reloadSettings(context);
        }
      }
    } else {
      let refs: string[];
      if (op === "provider") {
        if (typeof body.provider !== "string" || !body.provider) {
          return Response.json({ error: "provider is required" }, { status: 400 });
        }
        // Resolved server-side so a provider switched on stays on for models
        // the browser has not seen yet.
        refs = context.models
          .filter((model) => model.provider === body.provider)
          .map(modelRef);
      } else {
        const requested = stringArray(body.refs);
        if (!requested) return Response.json({ error: "refs must be an array of strings" }, { status: 400 });
        refs = requested;
      }
      edit = setModelsEnabled(input, refs, body.enabled === true);
    }

    if (!edit.ok) {
      return Response.json(
        { error: "At least one model must stay enabled", reason: edit.reason },
        { status: 409 },
      );
    }
    if (edit.changed) {
      // resync's primary edit is always the global one; the project write for
      // it already happened in its own branch above.
      if (targetScope === "project" && op !== "resync") {
        writeProjectEnabledModels(resolved.cwd, edit.patterns);
        context = reloadSettings(context);
      } else {
        await writeEnabledModels(context.settingsManager, edit.patterns);
      }
      invalidateModelsCache();
    }

    return Response.json(await buildView(context, targetScope));
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
