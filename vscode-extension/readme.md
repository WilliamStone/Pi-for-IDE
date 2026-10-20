# Pi for IDE — VS Code extension

![Pi for IDE screenshot](screen.png)

**Pi for IDE** embeds the [Pi Web+](https://github.com/WilliamStone/Pi-for-IDE) web UI — a Next.js frontend for the pi coding agent — into a VS Code webview panel, and adds a layer of deep integration for IDE workflows: chat with the agent, browse session history, configure models and skills, review and revert file changes — without leaving your editor.

The pi-web server is **not bundled**. It runs as a local process provided by the separately installable [`@william_stone/pi-web-for-ide`](https://www.npmjs.com/package/@william_stone/pi-web-for-ide) package, which also works standalone in a normal browser. The extension and the web app can be upgraded independently.

## Features

### 1. Embedded panel, externally served

- **Resolve chain**: `executablePath` setting → bundled `resources/` → global npm package → PATH shim (`pi-web-for-ide`) → managed runtime (the extension can install and keep its own copy under globalStorage — no global install required).
- **Attach-first**: if a patched pi-web instance is already listening on ports 3030–3039, the panel attaches to it instead of starting a duplicate. One server is shared across windows and keeps a single view of `~/.pi` data. When the attached port differs from your configured `Pi for IDE.port`, a notice explains what you connected to.
- **Embed handshake**: after connecting, the extension probes `GET /api/embed` and validates the wire protocol version. An upstream (unpatched) `pi-web`, an incomplete install, or a protocol mismatch each produce a specific warning with upgrade guidance — never a silent failure.
- **Port**: preferred start port 3030, auto-increments when occupied. The panel header also has an **Open in Browser** button.
- **Everything pi-web has**: session browsing, Markdown rendering, tool-call views, branch navigation, SSE streaming, i18n, themes.

### 2. Workspace integration

- **File browsing delegated to VS Code**: pi-web's own file tree / preview tabs / worktree switcher are hidden in embed mode; the Explorer and editor groups take over.
- **`@` file mentions**: the composer's `@` completion resolves through `vscode.workspace.findFiles` (top 50, paths only — no code snippets sent).
- **Right-click mentions**: *Pi for IDE: Mention This File* / *Mention This Code* on the editor and explorer context menus.
- **Clipboard bridge**: cross-origin iframes can't use `navigator.clipboard`, so copy/paste is routed through `vscode.env.clipboard`.
- **Active-file context**: the file you are viewing is injected into the system prompt as a hidden marker — visible to the model, not shown in the UI, never persisted to the session file. The composer also shows a `current file` hint so you know what the agent sees.

### 3. File review & one-click revert

After each turn, a **File review** card lists every file the agent touched:

- **Open diff in editor**: a native two-sided `vscode.diff`. The "before" side is reconstructed by reverse-applying that turn's edits; if the file drifted afterwards and reconstruction fails, the recorded unified patch opens instead with a notice.
- **Open file in editor**: jump straight to the file.
- **Revert this turn**: hover a user message → *Revert*. A snapshot taken when the turn started restores every touched file (write-created files are removed), then the turn's conversation entries are deleted and parent links re-joined — reverting a middle turn never loses later turns. Always asks for confirmation.
- **Git stays clean**: read-only git usage throughout — no stash, commits, or dangling objects.

### 4. Server lifecycle

- `Pi for IDE.autoStart`: start the server in the background when the extension activates (off by default).
- **Watchdog self-stop**: an extension-spawned server exits on its own after full silence — no heartbeat, no open page — for `autoStopAfterSec` (default 90 s, minimum 90 because hidden tabs poll ~once a minute). Servers you start standalone are never affected.
- `Pi for IDE: Stop Server` stops the instance this window manages.
- **Safe upgrades**: the npm package carries a preinstall guard — upgrading while a server holds its files fails early with clear stop instructions instead of a mid-install `os error 32`.

## Commands

| Command | Title |
|---|---|
| `Pi for IDE: Open` | Open the Pi for IDE panel |
| `Pi for IDE: Show Panel` | Reveal the panel (if already created) |
| `Pi for IDE: Start Server` | Start the local pi-web server |
| `Pi for IDE: Stop Server` | Stop the managed server |
| `Pi for IDE: Open in Browser` | Open the server in the system browser |
| `Pi for IDE: Mention This File` | Mention the file in the composer |
| `Pi for IDE: Mention This Code` | Mention the selection |
| `Pi for IDE: Upgrade Server Component` | Update the pi-web package |
| `Pi for IDE: Manage Server Versions` | Pick which installed copy runs |

## Settings

| Setting | Description |
|---|---|
| `Pi for IDE.executablePath` | Absolute path to a server entry (`standalone/server.js` or `bin/pi-web.js`). Empty → automatic resolve chain. |
| `Pi for IDE.package` | Package name used for managed/global lookups (default `@william_stone/pi-web-for-ide`; must be the IDE-patched build). |
| `Pi for IDE.workspaceRoot` | `cwd` passed to pi sessions; empty → current workspace folder. |
| `Pi for IDE.openBeside` | Open the panel in the adjacent column (default `true`). |
| `Pi for IDE.port` | Preferred start port (default `3030`). |
| `Pi for IDE.autoStart` | Start the server on activation (default `false`). |
| `Pi for IDE.autoStop` | Let spawned servers self-stop after silence (default `true`). |
| `Pi for IDE.autoStopAfterSec` | Silence threshold in seconds, min 90 (default `90`). |
| `Pi for IDE.checkForUpdates` | Check npm for a newer package once per activation (default `true`). |

## Requirements

- The pi-web server comes from `@william_stone/pi-web-for-ide` — install it globally (`pnpm add -g @william_stone/pi-web-for-ide`) or let the extension's managed runtime download it on first use.
- A running server needs Node.js ≥ 22.19 when launched via the PATH shim; the managed/spawned modes use the editor's bundled Node.

## Limitations

- The webview iframe is sandboxed: `window.confirm()` / `alert()` / `prompt()` are unavailable; confirmations use in-page UI.
- Attach scans ports 3030–3039 only. To force a dedicated server, set `Pi for IDE.port` outside that range.
- Revert restores only the files that turn touched; manual edits made afterwards are your own.
- `?embed=vscode` activates host mode (hides browser-only UI, enables the bridge) but does not affect standalone browser use.
