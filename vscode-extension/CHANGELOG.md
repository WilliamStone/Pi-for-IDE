# Changelog

## [0.3.0] - 2026-10-26

- **Native Pi Sessions sidebar**: a dedicated activity-bar view replaces the web sidebar for navigation — sessions grouped by project (or a flat "recent" mode), live running / awaiting-input icons, pinned projects and sessions at the top, and a one-click workspace filter. Startup stages ("Checking for a running server…", "Starting local server…") show inside the view while the server comes up.
- **Session actions, host-native**: right-click a session to rename, pin, archive, fork, or delete it; open it in the slim chat view or the full page; reveal its working directory in Explorer, open that directory in a new window, or spawn an integrated terminal on it.
- **Cross-window session routing**: sessions and projects outside the current workspace carry a floating *Open in Workspace Window* button — it routes through the IDE's own launcher, so the target workspace's window gets focused when it already exists and created when it doesn't. Session-level jumps also hand the session over: the destination window opens that session's tab automatically. Foreign projects get a distinct shortcut-style icon and sink below same-workspace groups; clicking a session directly still opens it in the current window.
- **Project-level actions**: pin / unpin / rename a project group, start a new session on it, or jump straight to its workspace window.
- **Per-session tabs**: `Pi for IDE.sessionTabs` — `perSession` gives each session its own tab (a new-session composer tab re-keys onto the session it creates), `shared` keeps one tab.
- **Awaiting-input surfacing**: sessions waiting on you show a badge in the tree, a status-bar count (click to open the next one), and an optional notification via `Pi for IDE.notifyAwaiting`.
- **Dramatically faster startup**: ~38s of Windows shell-outs moved off the resolution path, a persistent V8 compile cache for spawned servers, tarball identity reads switched to async I/O (no more extension-host freezes on slow disks), and the session list now appears as soon as the server port is bound — during the embed route's lazy-load, not after it.
- **Startup observability**: a timestamped lifecycle timeline in the output channel (resolution legs, spawn, handshake, first session data) makes every slow stage attributable.
- **Cross-window coordination**: a shared server mutex serializes version checks / spawn / upgrades across windows; server shutdown requires consent — a stop request is refused while another client is still connected; instance markers are monotonic and never evict a newer instance.
- **Upgrade UX**: toasts gained a one-click **Install** that applies the plan directly, a verdict line ranks local/registry/current candidates, and repeated prompts for the same decision are deduplicated per session.
- **Server resilience**: an EPIPE guard and a 300 s watchdog let the spawned server survive extension-host restarts; the sidebar auto-starts the server when it's opened.
- **Session tabs survive reloads and updates**: restored session/composer/main/settings tabs stay as lazy placeholders with their real titles instead of duplicating into parallel `Pi for IDE — <cwd>` tabs. The active tab is adopted in place on window reload; background tabs stay inert until clicked, then adopt the same DOM node; tree clicks swap the placeholder for a live panel in the same group — no orphaned duplicates.
- **Session list without the 10 s wait**: sidebar population no longer waits for the delayed visibility event — polling is kicked by the server-ready broadcast and at view registration, so the first list lands as soon as the server answers.
- **Empty-after-reload hardened**: a transient session-resolution miss during server startup now retries instead of silently showing an empty transcript, and a failed scroll-restore can no longer leave the message list permanently hidden. Degenerate responses are logged to the output channel for diagnosis.
- Requires pi-web-for-ide ≥ 0.12.2-2 for the newest capabilities (running/awaiting snapshots, session UI state, shutdown consent); older compatible builds degrade gracefully.

## [0.2.0] - 2026-10-20

- **IDE shortcuts work inside the panel**: chords the web app doesn't consume (Ctrl/Alt/Meta combos and F-keys) are forwarded out of the iframe and resolved by VS Code's own keybinding service — your custom keybindings and `when` clauses apply exactly like a normal keypress. (Requires the matching pi-web-for-ide build; OS/browser-reserved keys like Ctrl+W can't reach the page and remain unreachable.)
- **Choose where upgrades come from**: new `Pi for IDE.installSource` — `auto` compares both sides (same version → local wins), `prefer-remote` ties → registry, `local`/`registry` lock one side.
- **Install from local tarballs**: `Pi for IDE.localPackage` accepts a `.tgz` file *or a folder* — folder mode scans tarballs, validates the package name, and picks the newest by `(version, builtAt)` from the embedded `pi-web-build.json` build identity, so same-version rebuilds stay distinguishable. Local installs extract in-process — seconds instead of a minutes-long `npm i`, and no console-window flashes on Windows.
- **One upgrade decision everywhere**: the Upgrade command and the background check share a single plan. Toasts carry the full comparison (installSource, each candidate's version + build stamp, current build) with a `Details…` button that opens the focused Pi for IDE output channel; the background **Install** applies the plan in one click — no second confirmation, and every install ends with a restart prompt or an explicit "takes effect on next start".
- **Newest installed copy wins, stamps included**: at spawn time, same-version installed copies compare build stamps — a same-version stale global install no longer shadows a newer managed build.
- **Cross-window server handoff**: the host that (re)starts a server writes a shared instance marker; other windows' panels switch to the new instance automatically — same-port restarts included, distinguished by an instance token in the embed URL. A post-upgrade note reminds you that browser tabs need a manual reload.
- **Out-of-session diffs fixed**: "Open diff in editor" now works for files the agent edited *outside* the session cwd — the read-only reconstruction path no longer carries a write-path guard.
- **Cold-start race fixed**: opening the panel while `autoStart`'s spawn was still in flight served a `serverReady` pointing at `http://127.0.0.1:0` — the shell probed a dead port for 90s. The reuse branch now awaits the in-flight start.
- **Port-race fallback**: when another pi-web wins the bind between probe and spawn (cold-boot reality), the extension first tries to attach to the winner; if the occupant isn't an embed-capable instance of this package, it respawns on the next free port. A duplicate of *our* server is never created — two instances would write the same `~/.pi` state.
- **Attach transparency**: attaching to a port different from `Pi for IDE.port` now shows a notice — a configured port no longer silently connects to a sibling window's server.
- **Two-sided diffs**: "Open diff in editor" reconstructs the pre-turn file by reverse-applying that turn's edits (native `vscode.diff`); when the file drifted afterwards and reconstruction fails, the recorded unified patch opens instead with a notice. Fallback branches now log their exact reason to the Pi for IDE output channel.
- **Path canonicalization**: cwd and file paths resolve through realpath and repo-toplevel with case-insensitive keys — snapshot/diff lookups no longer miss files opened via junction aliases or differently-cased paths on Windows.
- **Shell reliability**: shell state replays on the "shell painted" message, closing a postMessage race that could leave the gate stuck.
- **Managed runtime picks the newest compatible installed copy**, not the first leg that resolves.
- **Marketplace readme restored** as a dedicated, user-facing document (English + 中文), replacing the repo-root README sync.
- **Real-UI e2e**: `npm run test:e2e` drives actual VSCodium via `playwright._electron` — panel loading, file-review host actions (diff/open/patch-fallback), a live-model turn + revert (opt-in `PI_E2E_LIVE=1`), and the watchdog self-stop (`PI_E2E_SLOW=1`) — with a coverage ledger that calls out any segment skipped rather than letting a green tally hide it.
- Package-side (pi-web-for-ide ≥ 0.12.2-1): a **preinstall guard** turns the mid-install `os error 32` into actionable "stop the server first" guidance; the bin command is exclusively `pi-web-for-ide` so the package coexists with upstream `pi-web`; the embed handshake now reports a process `boot` id, the welcome page keeps the IDE logo across in-app navigation (and it's larger), and the page forwards unconsumed chords for IDE shortcut routing.

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
