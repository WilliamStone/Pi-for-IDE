# Changelog

## [0.1.7] - 2026-10-17

- **Versioned managed runtime**: server downloads now install into `globalStorage/runtime/versions/<version>` with a `current-version` marker — upgrades land in a fresh directory and flip the marker, so a running server (this window or a sibling window's) is never touched; restart picks the new version. Replaces the in-place `npm i --prefix` layout that could hit `EBUSY` on Windows.
- **Bridge-level compatibility gate**: the package declares `piIde.level` and the extension supports a bounded range — registry queries pick the newest *compatible* version; a package that needs a newer extension produces an "upgrade the extension" message instead of a broken install.
- **New commands**: `Pi for IDE: Upgrade Server Component` (also wired to the background update notification) and `Pi for IDE: Manage Server Versions` (list installed versions with level/compatibility marks, switch the marker including downgrade, clean up old versions).
- **New setting** `Pi for IDE.autoStart` (default off): start the local server in the background at activation.
- **Single-document webview shell**: waiting/status/gate/error/iframe all live in one HTML driven by `postMessage` — no more double webview reloads and long blank gaps; a progress toast appears if the webview takes >6s to paint. `retainContextWhenHidden` keeps the panel alive between reveals.
- **`npx` fallback leg removed** from the resolution chain; a transitional activation sweep still kills orphaned `_npx`-resident servers left by older versions.
- **Stop** kills the whole process tree (`taskkill /T` / process-group kill); activation-time port scan classifies 303x occupants (legacy npx orphan / old unscoped package / upstream pi-web / ours) and only warns for foreign instances — never auto-kills intentional standalone runs.
- **i18n**: manifest strings localized via `package.nls.json` (English) + `package.nls.zh-cn.json`; all runtime strings unified to English.
- **Branding**: extension, settings, commands, status bar and in-app embed name unified as "Pi for IDE"; IDE-window icon shown in the embedded welcome page.

## [0.1.6] - 2026-10-17

- Store listing description switched to English.
- Icon: added a light border ring so the dark title bar stays distinguishable on dark themes.

## [0.1.5] - 2026-10-17

- Renamed the fallback command to `pi-web-for-ide` (matches the 0.12.1-2 package bin; the stale 0.1.4 upload referenced a nonexistent `pi-web-ide` bin in its npx fallback — superseded).

## [0.1.4] - 2026-10-17

- Fix: PATH shim resolution verified the shim's backing package — a stale install of the old unscoped `pi-web-for-ide` (or upstream `pi-web`) shim is now skipped in favor of the npx fallback, instead of launching the wrong package.
- Diagnose /api/embed 5xx as broken install (reinstall guidance) instead of mislabeling it as upstream pi-web.

## [0.1.2] - 2026-10-17

- Store listing readme now generated from the repository root README (single source of truth).
- New extension icon (IDE window with π).

## [0.1.1] - 2026-10-17

- Store listing readme bilingual (superseded by root-README sync in 0.1.2).

## [0.1.0] - 2026-10-16

Initial public release.

- Thin-shell extension: launches/connects to the external `@william_stone/pi-web-for-ide` server package and embeds it as a first-class webview panel.
- Resolution chain: `piIde.executablePath` → bundled resources → global package → PATH shim → `npx -y -p <pkg> pi-web` fallback.
- `/api/embed` handshake with protocol/version compatibility warnings.
- IDE integration: `@` file mentions, context-menu mentions, active-file context injection, file review cards with inline diffs and one-click turn revert, clipboard bridge.
- Lifecycle: readiness-gated panel loading, server stop/start with panel recovery, connection watchdog.
- One-click package install + background update checks against npm.
