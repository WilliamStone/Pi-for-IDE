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
  `PI_WEB_EMBED_WATCHDOG_TIMEOUT_SEC`, default 90). A standalone Pi Web+
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
- **Attach, not adopt:** `ensureStarted` prefers a healthy `kind==="ours"`
  server on ports 303x (handshake OK) over spawning a duplicate — one server
  serves many windows/workspaces (sessions keyed by cwd; pages are views of
  the same server, as in the standalone product).

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
