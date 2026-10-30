# Contributing to Pi for IDE / Pi Web+

[中文](./docs/CONTRIBUTING.zh-CN.md)

This repo produces two independently installable deliverables: the **`pi-for-ide` extension** (a thin VS Code/VSCodium host) and **`@william_stone/pi-web-for-ide`** ("Pi Web+", the pi-web web app plus a host-adaptation layer that also runs standalone in a browser). The product goal: make the pi agent feel like a native part of the editor — a real sessions tree, sessions and settings as editor tabs, native diffs and revert — while the web app stays useful on its own.

## What this project is for

- **The IDE integration layer.** Anything that makes pi belong in the editor: the Pi Sessions tree, per-session/composer/settings tabs, `@` mentions and active-file context, native diffs and turn revert, the embed lifecycle, multi-window behavior.
- **The host-neutral embed protocol.** `?embed=<host>` capabilities, messages and lifecycle live in `lib/embed/` and the extension bridge. VS Code is the first adapter; the abstraction must stay host-agnostic so JetBrains-class hosts can follow.
- **pi-web itself, kept upstream-compatible.** The web app is forked from `agegr/pi-web` and we keep merging upstream. Improvements to it are welcome when they don't deepen the fork delta.

## Out of scope

- **Changes to what pi itself does** — system prompt, tool behavior, prompt templates, retries, compaction, session-file format. Those belong upstream in the pi project.
- **pi-web-only extension API surface.** New `ctx.ui.*` options or `extension_ui_request` fields that pi-CLI extensions cannot express: extensions written for the pi CLI must behave identically here, and pi's TUI is the reference for what an extension request means.
- **Host-specific leakage into the shared substrate.** VS Code assumptions must not reach `app/`/`lib/` outside `lib/embed/` — embed features live in the adaptation layer and degrade gracefully in standalone mode.
- **Large rewrites of upstream-owned files.** Every in-place edit inside a pi-web file is a future merge conflict; keep upstream edits to minimal call-site additions (see the fork-delta rules in `AGENTS.md`).

## Conventions

- **Delta discipline**: embed/IDE features live in our own files first (`lib/embed/**`, `components/embed/**`, `vscode-extension/**`, `bin/pi-web-standalone.js`). When an upstream file must change, prefer adding a call site over changing signatures.
- **User-facing strings**: extension-manifest strings go through `package.nls.json` (en default + zh-CN); runtime strings everywhere else are English-only. See `docs/i18n.md` for the web app's own i18n.
- **Checks before PR**: `node_modules/.bin/tsc --noEmit`, `npm run lint`, `npm test`; for the extension `tsc --noEmit`, `npx eslint src`, `npm test` inside `vscode-extension/`. Never run `next build` during development (see `AGENTS.md`).
- **Topic notes**: `AGENTS.md` maps each code area to a note in `docs/agents/` — read the notes for every file you change, and record design decisions back into them.

## Pull requests

- One change per PR; split unrelated fixes.
- For a bug fix, explain how to reproduce it on `main` and why the change fixes the cause rather than the symptom.
- For a feature, open an issue first with the use case — especially for anything touching the embed protocol or the sessions view.
- Avoid new runtime dependencies; if one is needed, say why.
