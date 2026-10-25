# Embed protocol & lifecycle — pi-for-ide extension ↔ pi-web-for-ide

The contract between the IDE host extension and the web package. Read before
touching `app/api/embed/**`, `lib/embed/**`, `vscode-extension/src/**` server
code, or anything versioned by the handshake.

## Handshake

```
GET /api/embed → { "embed": { "protocol": <level>, "version": <pkg-version>, "capabilities": {…} } }
```

- `protocol` — integer **level**, bumped only on *breaking* contract changes
  (handshake shape, required behavior). Additive features never bump it.
- `capabilities` — flat map of optional features the server supports.
  Missing key = absent = client degrades, never errors.

## Capability registry

Every capability key is namespaced `domain.feature` (flat transport, logical
tree). Values are `true` or an object carrying parameters
(`"lifecycle.heartbeat": {"timeoutSec": 90}`) — parametric features declare
their config in-band instead of minting new keys.

Rules:

1. **Register before shipping.** An unregistered key is not allowed in a
   released package. Each row: name, since-version, semantics, client behavior
   when absent.
2. **Additive only.** Never remove or rename a key. Deprecate by keeping the
   key, marking it deprecated, and adding the new key.
3. **Level ≠ capabilities.** The level is the minimum contract; capabilities
   are optional extras. A feature that can be probed by name does not raise
   the level.
4. **Evolution path is reserved.** Dotted keys map mechanically onto a nested
   structure (`lifecycle.heartbeat` → `capabilities.lifecycle.heartbeat`), so
   a future tree restructure is a dual-publish transition, not a new protocol.

| key | since | semantics | if absent, client must |
|---|---|---|---|
| `lifecycle.heartbeat` | 0.12.2-2 | `POST /api/embed/heartbeat` accepted; presence resets the watchdog's silence timer | skip heartbeats; legacy lifecycle semantics (owner kill on deactivate) |
| `lifecycle.shutdown` | 0.12.2-2 | `POST /api/embed/shutdown` performs graceful exit | fall back to killing the spawned child only |

Baseline (level 1, unconditioned): embed handshake itself, `session_start`
dispatch, bridge message channel, mention push, file review, turn revert,
active-file hint, clipboard key interception.

## Lifecycle sovereignty

**The server process is the only sovereign.** It owns its lifetime by watching
its own clock; the extension and browser pages are *presence signals*, not
owners. Nobody kills anyone — the server dies of silence.

- **Armed per spawn, not per process kind.** The watchdog activates only when
  the extension spawned the process with `PI_WEB_EMBED_WATCHDOG=1` (+ tunables
  `PI_WEB_EMBED_WATCHDOG_TIMEOUT_SEC`; the extension injects its
  `autoStopAfterSec` setting, default 300 — long enough to survive a typical
  reload/restart gap so the next window attaches instead of cold-spawning).
  A standalone Pi Web+
  instance never carries the flag → heartbeats to it are harmless no-ops →
  attach/leave never affects standalone lifetime.
- **Presence = heartbeat OR open client connection.** Extension POSTs
  `/api/embed/heartbeat` every ~15s; any open SSE/WS client connection (IDE
  webview or browser tab) also counts. Death condition: both silent for T.
- **Browser tabs keep it alive** while open — a frozen-but-open tab still
  holds its socket, which is the desired semantic; a closed/discarded tab
  releases it. A browser page must never heartbeat.
- **Presence comes through three channels**: the extension's heartbeat, open
  SSE streams, and any API poll (every `/api/agent/running` request records
  client activity). The sidebar keeps polling while the page is hidden at a
  reduced ~30s cadence (browsers may throttle background timers to ~60s), so
  list/new-session pages — which hold no SSE — still count as presence. This
  is why the watchdog timeout floor is 90s: below that a throttled hidden tab
  could outlive its own keepalive window.
- **Sleep forgiveness.** Wall-clock drift detection, not files: each watchdog
  tick records `lastTick`; a delta far beyond the interval means the process
  just woke — reset the silence timer and grant one full grace window for
  the extension to re-heartbeat.
- **Extension side:** after spawn or attach, heartbeat if `lifecycle.heartbeat`
  is present; on `deactivate`, stop heartbeating and kill nothing — ever.
  Watchdog-armed servers reap themselves ~T after silence; legacy servers
  simply stay up as orphans and are reused by the next window's attach —
  cheaper than risking a kill of a server another window is using.
  `Pi for IDE: Stop Server` still force-kills the spawned child, and asks an
  attached (not-owned) server to exit via `lifecycle.shutdown`.
- **Server-side shutdown consent:** `POST /api/embed/shutdown` is not an
  unconditional kill. Heartbeats carry a per-extension-host `client` id
  (old clients without the field land in the anonymous `""` bucket). The
  endpoint refuses with `409 {error:"in-use", clients:n}` whenever a
  **provably different** live client exists — an identified request is
  refused if any *other* id is beating, an anonymous request is refused
  if any *identified* client is beating. `force:true` overrides
  (explicit `Stop Server` re-prompts then forces). Why: users can't be
  made to reload every window, so a stale-extension window keeps the old
  any-difference invalidation + attached-`stop()` murder chain; the
  server is the only enforcement point that works under version skew.
  Old+old pairs still merge into the `""` bucket (indistinguishable by
  design — that's self-consistent old behavior); the protection that
  matters is old-window → new-window murder.
- **Attach, not adopt:** `ensureStarted` prefers a healthy ours server on
  ports 303x (handshake OK) over spawning a duplicate — one server serves
  many windows/workspaces (sessions keyed by cwd; pages are views of the
  same server, as in the standalone product). Identity is proven by the
  `/api/embed` handshake itself, not by `classifyOccupier` cmdline
  heuristics — junction installs (`npm link`, global→repo) and install
  dirs whose names lack the package name misclassify our own server as
  `upstream`, which once caused sibling windows to spawn duplicates on
  fresh ports. Attach candidates are therefore every pi-web-shaped
  occupier (`kind !== "unknown"`); the cmdline kind survives only for
  warning text and cleanup decisions. The handshake also reports
  `builtAt`/`gitSha`/`installRoot` — same-version different-build copies
  are indistinguishable by `version` alone.
- **One operator (`src/server-lock.ts`):** "check version / resolve /
  spawn / install" is a cross-window critical section guarded by an
  `mkdir` file lock at `<agentDir>/pi-web-run/ide-server.lock` (same
  shared dir as the server's own run-records; honors
  `PI_CODING_AGENT_DIR`). Serialize, not lock-step: the holder's spawn
  waits for the port to listen before releasing, so a waiting window's
  post-lock attach lands on a ready server — this also closes the
  "bound but API not yet compiled" startup window that pure HTTP
  probing cannot see. Lock acquisition is degraded-safe: timeout or
  unwritable dir falls back to unlocked execution (pre-lock behavior);
  stale locks are swept by holder-PID liveness plus an age cap.
  `planUpgrade` additionally shares its result via a 60s plan cache in
  the same dir — expensive read-only work (registry fetch + full-tgz
  gunzip) runs once across windows. Interactive prompts stay outside
  the lock (user think-time must not hold a cross-window mutex), and
  the managed-runtime install keeps its own per-runtime-root lock
  (`versions/../.installing`) because installs of *different* roots do
  not contend.
- **Instance marker monotonicity:** `<runtime>/server-instance.json`
  announces the newest *spawned* instance (boot = `Date.now()` id).
  Other windows' watchers invalidate their local server only when the
  marker's boot is **strictly newer** — any-difference comparison lets
  a late-written stale marker evict a running newer instance, and two
  windows then ping-pong forever. Disposal follows ownership: a
  superseded **spawned child** is stopped (cleanup), but an **attached**
  instance is only released — `stop()` on it would POST
  `/api/embed/shutdown` and murder the shared server other windows are
  using (attach ≠ adopt). On a successful invalidation the watcher
  immediately re-`ensureServer()`s — the sessions tree isn't a panel,
  so without the re-attach it would sit at "server not running" until
  someone opened a panel.
- **Spawn boot records:** `spawn()` writes
  `ide-spawn-<pid>.json` (pid/port/url) into the shared run dir before
  the child binds — the spawn→bind window is otherwise invisible to
  port scans, and a sibling hitting it spawns a duplicate (the observed
  two-window race). Attach merges live <90s records as candidates and
  extends its wait to 60s when only records are visible. All marker /
  boot-record / invalidation logic lives in
  `vscode-extension/src/instance-coordination.ts` (pure module, no
  vscode dep — driven by `two-process-coordination.test.mjs`, which
  races real child processes over real files).

### Rejected: client registry

An earlier design tracked windows in `globalStorage/runtime/clients.json` with
per-window heartbeats. Killed by crash semantics: a dead window can't
deregister → stale entries read as alive → orphans survive the last exit.
"Die by default" needs no cleanup path.

### Turn revert semantics

`POST /api/sessions/[id]/revert-turn` deletes one turn's entries and rewires
each deleted entry's children to the removed turn's parent. Caveat: inside a
fork subtree this *beheads* the branch — surviving descendants re-attach to
the deleted turn's main-line parent. The tree still shows a fork (the parent
keeps multiple children), but the branch head becomes the orphaned
continuation, whose content may reference the deleted turn's context — same
incoherence as any mid-chain revert, made starker by the fork. An edge case;
reverting mid-fork is rare. Entries produced by subagent sessions are not
removed. The route refuses while the session is running (409) — the page
already gates the button on `sessionBusy`.

### Known gaps

- Browser tab on a dead IDE-spawned server shows a silently-retrying page —
  a reconnect-exhausted "server gone" UI is a future item.
- In-flight runs don't suppress the watchdog (v1: closing every window means
  die, run or not).

### Extension source layout (post-refactor)

`vscode-extension/src/` keeps `extension.ts` (~394 lines) as pure wiring;
each subsystem lives in its own module so a bug lands in one file:

- `session-panels.ts` — per-session/composer webview registry; re-keys a
  `new:<cwd>` composer panel onto the real session id on `sessionSelected`.
- `sessions-feature.ts` — sessions tree + awaiting status bar + settings
  panel + Open Original Page + session command wiring.
- `upgrade.ts` — EVERY upgrade surface: resolve-path downgrade warning
  (consumed via `onDowngradeWarning` event — `server-resolve.ts` emits, it
  does not toast), the +8s auto check, and the `piIde.upgrade`/`versions`
  commands. All three share `upgradeNotice.ts` signatures — one action pops
  one toast per session, reports still write to Output.
- `embedUrl.ts` — the `?embed/session/cwd/view/section/browserBtn/extVer/
  inst` contract; `session` and `cwd` are mutually exclusive (cwd reads as
  a new-session draft and would shadow the deep link).
- `config.ts` — `piConfig()`/`CONFIG_SECTION`; no bare
  `getConfiguration("Pi for IDE")` literals elsewhere.

Test seams: `node --test` + strip-types runs the unit files; a
`registerHooks` resolver adds `.ts` to extensionless relative imports and
redirects `vscode` to `test-vscode-stub.mjs`. Modules under test must avoid
TS constructs strip-types can't strip (constructor parameter properties —
use explicit fields) and keep vscode usage type-only where possible.
`AppShell.workspace-memory.test.mjs` slices `AppShell.tsx` source on
`const X = useCallback` boundaries and evals it in a vm — **bare statements
between those callbacks land in the slice and break on missing identifiers;
keep such code before `restoreWorkspaceContext` or inside a callback.**
