# Changelog

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
