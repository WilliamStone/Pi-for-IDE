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

## Orphan panels & serializer revival

Extension update kills the whole extension host — extension-side objects
(bridge, SessionPanels registry, `PiWebWebviewPanel` wrappers) die while the
tabs stay. Symptoms without revival: dead refresh buttons, iframe pointing at
a dead server instance (offline page), clicking a session opens a duplicate
tab instead of activating the orphan.

`registerWebviewPanelSerializer(viewType, …)` is the **only** API that re-takes
an existing `WebviewPanel` (tabs are read-only otherwise). It matches viewType
exactly, so dynamic viewTypes are discovered by enumerating
`vscode.window.tabGroups` at activation (`TabInputWebview.viewType`) and
registering one serializer per pi viewType (`sessions-feature.ts`
`revivePanel`). Registration at activation covers everything: panels created
later reappear in the next activation's enumeration.

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
- Bare `piIde.webview` orphans (pre-unique builds) get **no** serializer →
  VS Code closes them — dead tabs disappearing is the desired cleanup.
- Duplicate orphans (same viewType twice) → `SessionPanels.adopt` keeps the
  registered panel and disposes the extra.
