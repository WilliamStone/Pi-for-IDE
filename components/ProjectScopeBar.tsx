"use client";

import { useI18n } from "@/hooks/useI18n";
import type { EnabledModelsController } from "./EnabledModelsSection";
import { ConfigButton } from "./SettingsUi";

/**
 * Project-scope lifecycle for `enabledModels`, kept apart from the per-provider
 * switches on purpose: a project's `enabledModels` key lives in
 * `<cwd>/.pi/settings.json` and shadows the global list wholesale, which is a
 * cwd-level fact — not something a provider row can meaningfully own.
 *
 * One of its two actions is always available, so the bar is resident:
 * - no project key → "create" writes the currently effective list into the
 *   project file (confirm first: from then on this project no longer follows
 *   global changes);
 * - a project key → "delete" removes just that key (confirm) plus a
 *   global/project edit-domain switch, since edits to the shadowed global no
 *   longer affect this project.
 *
 * A corrupt project file gets an error line instead of actions: writes there
 * would fail or lose the user's other keys.
 */
export function ProjectScopeBar({ controller }: { controller: EnabledModelsController }) {
  const { t } = useI18n();
  const { view, pending } = controller;
  if (!view) return null;

  if (view.projectFile === "corrupt") {
    return (
      <div className="enabled-models-banner">
        <span className="enabled-models-banner-text">
          {t("models.projectFileCorrupt")}
        </span>
      </div>
    );
  }

  const busy = pending !== null;

  if (!view.hasProjectKey) {
    return (
      <div className="enabled-models-banner">
        <span className="enabled-models-banner-text">
          {t("models.scopeGlobalActive")}
        </span>
        <ConfigButton
          size="small"
          disabled={busy}
          title={t("models.scopeCreateHint")}
          onClick={() => {
            if (window.confirm(t("models.scopeCreateConfirm"))) controller.createProjectConfig();
          }}
        >
          {t("models.scopeCreate")}
        </ConfigButton>
      </div>
    );
  }

  return (
    <div className="enabled-models-banner">
      <span className="enabled-models-banner-text">
        {t("models.scopeProjectActive")}
        {view.editScope === "global" && ` — ${t("models.scopeGlobalNotEffective")}`}
      </span>
      <ConfigButton
        size="small"
        disabled={busy || view.editScope === "project"}
        title={t("models.scopeEditProjectHint")}
        onClick={() => controller.setEditScope("project")}
      >
        {t("models.scopeEditProject")}
      </ConfigButton>
      <ConfigButton
        size="small"
        disabled={busy || view.editScope === "global"}
        title={t("models.scopeEditGlobalHint")}
        onClick={() => controller.setEditScope("global")}
      >
        {t("models.scopeEditGlobal")}
      </ConfigButton>
      <ConfigButton
        size="small"
        variant="danger"
        disabled={busy}
        title={t("models.scopeDeleteHint")}
        onClick={() => {
          if (window.confirm(t("models.scopeDeleteConfirm"))) controller.clearProjectConfig();
        }}
      >
        {t("models.scopeDelete")}
      </ConfigButton>
    </div>
  );
}
