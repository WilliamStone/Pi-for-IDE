# Webview editor panels — tabs, menus, revival

VS Code platform mechanics behind `webviewProvider.ts`, `session-panels.ts`,
the `editor/title/context` menu declarations, and `resources/shell.js`
persistence. Read before touching any of them.

## Webview editor resource URI

Every webview editor tab carries a unique resource URI:

```
vscode-webview://webview-panel/webview-<providerId>-<uuid>
providerId = mainThreadWebview-<viewType>
```

The **viewType is embedded in the URI** — so a per-panel-unique viewType turns
the URI into a deterministic panel identity. Our scheme:

| panel | viewType |
|---|---|
| session | `piIde.webview.s.<sessionId>` |
| composer | `piIde.webview.n<seq>` |
| main / settings | `piIde.webview.main` / `piIde.webview.settings` |
| legacy (pre-unique builds) | `piIde.webview` |

`SessionPanels.byViewTypeUri(path)` matches `viewType + "-"` against the URI
path (the uuid segment is `-`-delimited, so `n1` can't collide with `n12`).

## editor/title/context — what the platform actually does

From `editorTabsControl.ts` `onTabContextMenu`: before showing the menu VS Code
**temporarily swaps a set of context keys to the clicked editor**, and restores
them on hide. Swapped: `resourceContext` (→ `resourceScheme`, `resourcePath`,
`resourceFilename`, `resourceSet`, …), pin/dirty/sticky/cannotClose/split flags,
and `editorAvailableEditorIds`. **Not swapped:** `activeWebviewPanelId`,
`activeEditorId` — those always describe the *active* editor.

Commands get `menuActionOptions.arg` = the clicked editor's resource URI
(`EditorResourceAccessor.getOriginalUri`). Right-click does **not** activate
the tab (verified: right-clicking an inactive tab does not make it active).

Consequences:

- "Copy Path"-style file items work per clicked tab because they gate on the
  swapped resource keys and consume the URI arg — we copy that pattern.
- A `when` cannot ask "is the clicked tab a webview of viewType X" — no
  clicked-tab viewType key exists. Closest: the URI itself, when present.

### When-clause dual track

```
resourceFilename =~ /webview-.*piIde\.webview/           // new bases: precise
|| activeWebviewPanelId =~ /piIde\.webview/ && !resourceSet  // old bases: fallback
```

- New bases (webview inputs carry a resource): `resourceFilename` is
  `webview-mainThreadWebview-<viewType>-<uuid>` → viewType match, exact for the
  clicked tab regardless of active state. `!resourceSet` in clause two blocks
  it, so no double-fire needed.
- Old bases (webview inputs had no resource): `!resourceSet` is the *only*
  clicked-tab signal separating webviews from every resource-bearing editor
  (file/untitled/git/vscode/diff/notebook/custom…). Residual: other
  resource-less tabs (terminals, output, foreign webviews) show the menu while
  a pi tab is active — unavoidable; commands no-op on non-pi URIs.
- `resourceScheme != 'file'` was tried and rejected: it enumerates editor
  *kinds*, missing untitled/git/vscode:/diff — `!resourceSet` is the correct
  abstraction ("has a resource" vs "which scheme").

Command-side targeting mirrors this: arg URI → `byViewTypeUri` (exact panel);
missing/foreign URI → `sessionPanels.active()` fallback (old bases only).

## view/title menu commands get the tree's selection as arg

Measured (L-segment e2e + `[settings]` output log): a `view/title` (the
view `…` overflow) menu command on a TreeView is invoked with the **tree's
current selected element as its first arg** — the same `TreeItem`
`view/item/context` passes. Right-clicking a row also selects it, so a
handler that branches on `item` silently tracks "the last tree element the
user touched": the project-settings view menu opened the last
right-clicked project's `settings.json` instead of the workspace's (log
proof: `item=cv=piIde.project.wsForeign` on both invocations).

Corollary: a command id shared between `view/title` and `view/item/context`
cannot tell which entry fired — the args are identical items. When the two
entries need different targets, register **separate command ids**:
`piIde.sessions.editProjectSettings` ignores its arg and resolves the
configured cwd; `piIde.sessions.editProjectSettingsHere` reads
`item.group.root`; the item variant is hidden from the palette via
`commandPalette: when:false`. Any view/title command that *uses* its arg
should be treated as suspect on this view.

## Orphan panels & serializer revival

Extension update kills the whole extension host — extension-side objects
(bridge, SessionPanels registry, `PiWebWebviewPanel` wrappers) die while the
tabs stay. Symptoms without revival: dead refresh buttons, iframe pointing at
a dead server instance (offline page), clicking a session opens a duplicate
tab instead of activating the orphan.

`registerWebviewPanelSerializer(viewType, …)` is the **only** API that re-takes
an existing `WebviewPanel` (tabs are read-only otherwise). It matches viewType
exactly, so dynamic viewTypes are discovered by enumerating
`vscode.window.tabGroups` (`TabInputWebview.viewType`) and registering one
serializer per pi viewType. The whole revival concern — enumerate → register →
dispatch on deserialize → orphan registry — lives in `panel-revival.ts`
(`registerOrphanPanelRevival`); `sessions-feature.ts` only wires its deps and
the reveal-path swaps.

Enumeration is **re-entrant and reactive**, not one-shot at activation — a
one-shot enumeration loses the race against editor restore: on window reload
`tabGroups` is still empty when activation runs (e2e-proven: zero
`[revive]` log lines post-reload), and under host restart it can be
unsynced too. `enumerate()` therefore runs at activation, on every
`onDidChangeTabs` (opened/changed), and on sessions-list load
(`onExtraEnumerate` ← `sessionsProvider.onDidChangeTreeData`). Late
registration is safe: inputs that already resolved sit in the revival pool
and drain the moment a matching reviver registers. The enumeration also
filters out live panels by viewType (`sessionPanels.all()` + open
main/settings) — tabs the *current* host opened must never enter the orphan
registry, or a later tree click would swap-kill a healthy tab.

**Trap — `TabInputWebview.viewType` is the providerId form**, i.e.
`mainThreadWebview-piIde.webview.s.<id>` (observed on VSCodium 1.140), not the
raw viewType. `registerWebviewPanelSerializer` matches the panel's *raw*
viewType (`piIde.webview.s.<id>`), so the `mainThreadWebview-` prefix must be
stripped before registering — registering the enumerated value verbatim
silently never fires `deserializeWebviewPanel`. `barePiViewType` in
`session-panels.ts` owns the strip: every viewType comparison (registration
name, the `OrphanRegistry.drop` key on `panel.viewType`,
`SessionPanels.adopt`'s stored viewType) must go through it — a mixed
raw/prefixed comparison silently misses.

- `deserializeWebviewPanel(panel, state)` → `PiWebWebviewPanel.adopt(panel,
  state)` → `attachPanel` (shared with `createWebviewPanel` path: icon, shell
  html, dispose/bridge hooks) + state restore + fire-and-forget `refresh()`
  (server may still be starting; shell gate shows meanwhile).
- `webview.options` are reset by deserialize — `adopt` re-sets
  `enableScripts`. `retainContextWhenHidden` is creation-only and can't be
  restored → adopted panels reload the shell on hide→show; the existing
  `shell painted` → `replayShellState` machinery re-arms the iframe URL.
- **State chain:** host posts `{kind:'persistState', state:{sessionId,cwd,
  view,section,title}}` (deduped by JSON) from `refresh()`/`bindSession`/
  `setTitleOverride` → shell `vscode.setState(state)` → deserialize receives
  it. sessionId also comes from the viewType for `s.*`; composers rely on
  state (`sessionId` if it landed a session, else `cwd` → `new:<cwd>` key,
  else `panel.dispose()`).
- Bare `piIde.webview` orphans (pre-unique builds) get **no** serializer and
  **no** placeholder — closed at enumeration (identity is unrecoverable;
  drafts survive app-side anyway).
- Duplicate orphans (same viewType twice) → `SessionPanels.adopt` keeps the
  registered panel and disposes the extra.

### deserialize is lazy per-tab — lazy placeholders

`deserializeWebviewPanel` fires **only for editor inputs that get resolved**,
not on registration. Verified in the installed VSCodium build
(`workbench.desktop.main.js`, unminified symbols):

- Restored webview editors are `LazilyResolvedWebviewEditorInput` (created
  by `WebviewEditorInputSerializer.deserialize` → `openRevivedWebview`).
  Its `resolve()` runs from the WebviewEditor pane's `setInput` — i.e. when
  the tab becomes the rendered/active editor of its group (restore of the
  group's active tab, or a user click). Background tabs never resolve.
- `resolve()` → `resolveWebview` → `tryRevive` over registered revivers;
  no match → `revivalPool.enqueueForRestoration` (waits in a pool).
- `registerWebviewPanelSerializer` → `$registerSerializer` →
  `registerResolver` → `revivalPool.reviveFor` drains queued inputs that
  match `canResolve`. A registration only revives inputs that have
  *already* resolved; it does not reach unresolved background tabs.
- `webviewPanelViewType` prepends `mainThreadWebview-` on `fromExternal`
  (registration arrives raw, inputs compare prefixed) — stripping the
  prefix before registering is required and correct.

Consequence: an orphan that is never activated can never be adopted — and
there is no extension-side API to force `resolve()` (tabGroups exposes tabs,
not inputs). Note the path matters (e2e-verified): **window reload** restores
webview inputs as lazy `IG` inputs (active-in-group resolves at restore →
auto-adopt once its serializer registers; background stays lazy until
clicked). **Extension-host restart** keeps the already-resolved `Mp` inputs —
`resolve()` is not re-run, `deserialize` never fires, and the orphan is a
permanent dead shell recoverable only by the reveal-path swap. So adoptable
orphans are kept as **lazy placeholders** instead of being swept: the tab
keeps its serialized title, looks normal, and:

- **clicked** → resolve → deserialize → `adopt` revives it in place (same
  DOM node, exact position — the best outcome);
- **targeted by openSession/reveal** (tree click, pending-open, settings,
  openOriginal, openSessionFull) → the matching `OrphanRegistry.take*` pulls
  it out and `sessions-feature` swaps it: close the placeholder, reopen an
  equivalent live tab at `tab.group.viewColumn` (live-read first, snapshot
  fallback) with the dead label's `Pi — ` prefix stripped back to a session
  title — no duplicate ever coexists with the placeholder;
- **never touched** → harmless tombstone (title stays correct);
- **manually closed** → `onDidChangeTabs` drops it from the registry.

Only un-adoptable orphans are closed proactively: legacy `piIde.webview` at
enumeration, and in `dispatch` a session whose id is confirmed gone
(`sessionExists` → `sessionsProvider.listLoaded && !sessionById`) or a
composer with no `sessionId`/`cwd` in state — clicking one disposes the
panel, so the placeholder self-cleans instead of showing a blank panel.

The earlier close+reopen sweep was removed: mass tab death at T+5 s bought
"live" tabs nobody was looking at, while the placeholder + swap costs
nothing visible and preserves exact position/DOM on click-adopt.

Diagnostics: `[revive] serializer registered for viewType=…`,
`[revive] deserialize fired viewType=… state=…`,
`[revive] session <id> no longer exists — closing orphan`,
`[revive] legacy orphan … — closing (unrecoverable)`.

### TreeView visibility events can lag (sessions sidebar)

Same platform family, different event (VSCodium 1.140): clicking the Pi
activity-bar icon rendered the sidebar immediately, but
`sessionsView.onDidChangeVisibility` (and with it `setVisible(true)` →
`tick` → first `pull`) arrived ~10 s later — log proof: `ensureStarted:
reusing` and `sessions poll: base resolved` share a millisecond, ~10 s after
`boundOrigin`/`resolvedOrigin` were already usable. The wait was event
latency, not server time.

Mitigation lives in `SessionsTreeProvider.kick()`: a status-broadcast kick
also pulls while **invisible** when the list has never been loaded
(`listVersion === -1`) — the last pre-ready stage emit (`Waiting for the
server API…`) fires after `boundOrigin` is set, so the warm pull lands data
seconds before the user opens the view. `sessions-feature` also fires one
kick at registration to cover cross-window attach (no status broadcasts in
this window at all). Once loaded, the invisible gate applies as before.

### Reload: session chrome without content

Reported shape: after `Developer: Reload Window`, the adopted session tab
shows the pi-web chrome (top tab bar, composer) but the message area stays
empty — no error, no loading text. Verified healthy end-to-end (real logs +
e2e): deserialize → adopt → serverReady → probe → iframe → `session_start`
dispatched. The empty state therefore lives past `loadSession`'s fetch: the
only silent-empty branches are `/api/sessions/<id>` → 404 (clears messages
with `setError(null)`) or a 200 with an empty `context.messages`.

Hardening landed in three places:

- `loadSession` retries a mount-path (`force`) 404 once after 700 ms before
  accepting the empty state — a transient `resolveSessionPath` miss right
  after a server respawn self-heals; a truly deleted session only pays one
  extra fetch.
- `app/api/sessions/[id]/route.ts` logs its degenerate outcomes to stdout
  (`404: resolve miss`, `empty-context: entries=… leaf=… liveRpc=…`,
  `500: …`), which lands in the `Pi for IDE` output channel — the next real
  occurrence shows which branch fired.
- `ChatWindow`'s scroll-restore `locate()` now catches a failed
  `loadOlderPage` — before, a single thrown fetch left
  `pendingScrollRestore` set forever and the message list rendered
  `visibility:hidden` (same chrome-only symptom, different layer).

E2E note: a 12-round reload loop against a seeded session never reproduced
the empty state (content present every round), and a standalone-server
hammer of the real mount-path fetches (`force=1` detail + state + SSE +
list, cold and warm) returned 200 + full context every time — the failure
needs a transient we have not isolated yet; the diagnostics above are the
capture mechanism.

### Connection pool: SSE lives on the extension host, not the webview

~6 simultaneously-visible session panels used to exhaust Chromium's ~6
per-origin HTTP/1.1 pool (each session iframe holds a permanent SSE), so
the *next* panel/navigation starved — observed as settings/sessions
retrying while open tabs looked fine. Hidden webview tabs also report
`document.visibilityState === "visible"`, so page-side suspension can't
work. Resolved architecturally: the embed page's `window.EventSource` is a
bridge-backed proxy and streams live on the extension host — details in
[embed-protocol.md](embed-protocol.md#event-streams-sse--extension-host-proxy).
