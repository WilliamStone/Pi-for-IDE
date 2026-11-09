# Pi for IDE — VS Code extension

**[Pi for IDE](https://github.com/WilliamStone/Pi-for-IDE)** makes the Pi agent a native part of your editor: the session list is a real tree in the activity bar, chats and settings open as editor tabs, and file reviews run through native diffs — it looks and works like something the IDE shipped with, not a web app in a frame.

![Main UI](../docs/screenshots/main-ui.png)

## What you get

### Pi Sessions sidebar (activity bar)

The **Pi Sessions** view in the activity bar — a native session tree and the entry point to everything:

- **Free layout**: like every activity-bar view, drag it anywhere or merge it with other views.
- **Workspace filter**: toggle between current-workspace sessions and all sessions; sessions and projects from other workspaces can be opened in their own workspace window.
- **Grouped by project** (or a flat *Recent* mode), with live **running** / **awaiting input** icons; projects and sessions can be pinned to the top.
- **Session meta**: last-active time and message count shown in the tree, so the session you want is easy to spot — switch between a trailing inline layout and a two-line layout.
- **Collapse All / Expand All**: handy when projects and sessions pile up.
- **Session actions**: open, open in the full page, rename, pin, archive, fork, delete, copy title, copy workspace path — plus directory actions: reveal in Explorer, open the workspace in a new window, open in an integrated terminal.
- **Project actions**: new session, rename, pin, copy path, edit the project's `.pi/settings.json`.
- **Cross-workspace jumps**: send a session from another workspace to its own window in one click.
- **Awaiting input**: sessions waiting on you get a badge in the tree, a status-bar count that cycles to the next one when clicked, and an optional toast.
- **Settings entry**: open the global settings page; edit a project's `.pi/settings.json`.
- **Drafts survive**: unsent text in the composer survives server restarts and window reloads.

### Session tabs (editor area)

Sessions open as **editor tabs**, on equal footing with your code files:

- **A tab per session** (`perSession`) or one shared tab (`shared`) — `Pi for IDE.sessionTabs`.
- **Many sessions in parallel**: every session gets its own tab — spread as many as you like across the editor, freely mixed with file tabs.
- **The full chat experience**: streaming output, tool-call detail, branch navigation, full-history / system / tools / token-usage views, themes and multi-language UI — laid out to feel at home in the IDE.
- **Tab context menu**: reveal the session in the tree, copy its workspace path, reload the page.
- **Survives reloads and updates**: after a window reload or extension update, session tabs keep their titles and restore in place.
- The **+** button on file-editor title bars: start a new session in the workspace of the file you're reading, in one click.

#### Editor integration

- **`@` mentions**: type `@` in the composer and pick workspace files — powered by VS Code's own file search.
- **Right-click mentions**: *Mention This File* / *Mention This Code* on editor and Explorer context menus.
- **Active-file awareness**: the file you're viewing quietly enters the agent's context, with a hint in the composer so you always know which file it's looking at.
- **Clipboard parity**: copy/paste inside the panel behaves like everywhere else in the editor.
- **IDE shortcuts stay live**: chords the app doesn't consume (Ctrl/Alt combos, F-keys) fall through to VS Code's own keybinding service — your keybindings and `when` clauses apply as usual.

#### File review and revert

After each turn, a **File review** card lists the files the agent touched:

- **Native two-sided diff** (the VS Code diff editor) — even for files the agent edited outside the session's own folder.
- **Open file in editor**.
- **One-click revert**: files return to their pre-turn state and the turn's conversation entries are removed; reverting a middle turn never loses later turns. Always confirmed first.

### Settings tab

- **Settings page**: a complete, native-feeling settings surface — models and API keys, OAuth, MCP, skills, plugins, themes — all configured in-panel, sharing `~/.pi/agent/` with the pi CLI.
- **Curated models**: mark your usual models to trim the model list shown in the chat UI.

### System features

- **Server component updates**: automatically checks for new versions against both a local folder and the npm registry, and shows a source / version / build-stamp comparison.
- **Shared server instance**: multiple windows and browser tabs connect to the same server — a single view of sessions and configuration, no duplicate processes.
- **Self-managing server**: can start with the editor; a server the extension spawned exits on its own after every window and page has been disconnected for a quiet period — manually started servers are never managed.

## Screenshots

- Settings page

![Settings](../docs/screenshots/native-settings-ui.png)
Adds an enabled-models section.

- Session tree view menu

![Session view menus](../docs/screenshots/session-view-menus.png)

- Session tree project menu

![Session tree project menu](../docs/screenshots/session-view-project-popup-menu.png)

- Session tree session menu

![Session tree session menu](../docs/screenshots/session-view-session-popup-menu.png)

- Session tree embedded in another view

![Session tree embedded](../docs/screenshots/session-view-embedded.png)

- F1 command list

![F1 command list](../docs/screenshots/f1-command-list.png)

## Commands

| Command | What it does |
|---|---|
| `Pi for IDE: Open` | Open the Pi for IDE panel |
| `Pi for IDE: Show Panel` | Reveal an already-created panel |
| `Pi for IDE: Start Server` | Start the local server |
| `Pi for IDE: Stop Server` | Stop the server this window manages |
| `Pi for IDE: Open in Browser` | Open the same UI in your system browser |
| `Pi for IDE: Open Original Page` | Open the embedded UI outside the slim shell |
| `Pi for IDE: Settings` | Open the Pi settings view |
| `Pi for IDE: Mention This File` | Mention the active file in the composer |
| `Pi for IDE: Mention This Code` | Mention the current selection |
| `Pi for IDE: Upgrade Server Component` | Update the server component |
| `Pi for IDE: Manage Server Versions` | Choose which installed version runs |

Session and project actions (open, rename, pin, archive, fork, delete, directory and window routing, workspace filter) live on the **Pi Sessions** view's context menu; the view title bar offers new-session, workspace-filter, single/two-line layout toggle, and collapse/expand-all buttons, while the "…" menu holds refresh, grouped/recent switch, Open Original Page, settings, and the workspace `.pi/settings.json`. Session-tab context menus offer *Reveal in Sessions* / *Copy Workspace Path* / *Reload Page*.

## Settings

| Setting | What it controls |
|---|---|
| `Pi for IDE.autoStart` | Start the server when the editor loads (default off). |
| `Pi for IDE.autoStop` | Let the spawned server exit after everyone disconnects (default on). |
| `Pi for IDE.autoStopAfterSec` | Silence before self-stop, min 90s (default `300`). |
| `Pi for IDE.port` | Preferred port (default `3030`; auto-bumps when taken). |
| `Pi for IDE.workspaceRoot` | Which folder the agent works in. Empty → current workspace. |
| `Pi for IDE.sessionTabs` | `perSession` gives each session its own tab; `shared` keeps one (default `perSession`). |
| `Pi for IDE.openBeside` | Open the panel in the adjacent column (default on); off → the active column. |
| `Pi for IDE.notifyAwaiting` | Toast when a session starts waiting for your input (default on). |
| `Pi for IDE.showOpenInBrowser` | Show the Open-in-Browser button in the panel top bar (default on). |
| `Pi for IDE.executablePath` | Point at a specific server build. Empty → automatic. |
| `Pi for IDE.package` | Which package provides the server (default `@william_stone/pi-web-for-ide`). |
| `Pi for IDE.checkForUpdates` | Notify when a newer server package exists (default on). |
| `Pi for IDE.localPackage` | Path to a local server tarball, or a folder of `.tgz` builds — the newest wins by version + build stamp (default empty). |
| `Pi for IDE.installSource` | Upgrade source: `auto`, `prefer-remote`, `local`, `registry` (default `auto`). |
| `Pi for IDE.sessions.metaLayout` | Session-row layout: `line` = title plus a dimmed meta row (default) / `inline` = compact single row. |
| `Pi for IDE.sessions.titleMaxWidth` | Max session-title width in visual columns (CJK/fullwidth count as 2); longer titles truncate with an ellipsis. `0` = no truncation (default `32`). |

## Usage notes

- **The server manages itself**: a server started by the extension exits after `autoStopAfterSec` (default 5 minutes) once every window and page disconnects; an open browser tab counts as in-use. For a long-lived server, start one manually with `pi-web-for-ide` — those are never auto-stopped.
- **Shutdown protection**: a stop request is refused while another window's panel is still connected — closing your window never kills the server out from under a sibling. This is intentional.
- **Upgrades**: when a newer package exists, a toast shows the full comparison (source, version, build stamp) with a one-click **Install** and **Details…** for the table; if a server is running you're asked to restart first, so nothing half-installs.
- **Your own instance**: set `Pi for IDE.port` outside 3030–3039 — this window then starts/connects to a separate server on its own port instead of joining the shared instance on the default range (panels on that port still share that one server).
- **Want the full page**: the panel defaults to an IDE-fitting slim shell; `Pi for IDE: Open Original Page` (also on the sidebar title menu) opens the untrimmed interface, and `Open in Browser` opens the same thing in your browser.
- **Revert's safety line**: revert only restores files the turn wrote; files you manually edited after the turn are skipped with a notice instead of being overwritten.
- **Same data, two fronts**: the same server serves the panel and your browser — `Open in Browser` opens the same sessions and configuration.

## Upstream & credits

- **[pi](https://github.com/earendil-works/pi)** (earendil-works): the underlying coding agent.
- **[pi-web](https://github.com/agegr/pi-web)** (agegr): the Next.js web UI for pi — the interface the panel hosts.
- **[pi-code](https://github.com/wangjinxin613/pi-code)** (wangjinxin613): the original IDE integration — the extension, embed bridge, file review/revert, and active-file injection all originate there; this extension is rebuilt on that work.
- **[Pi-for-IDE](https://github.com/WilliamStone/Pi-for-IDE)** (this repo): what this project adds on top of pi-code:
  - Native **Pi Sessions** tree (activity bar): by-project / recent modes, single- and two-line meta layouts, a collapse/expand-all two-state button, workspace filter, awaiting badges, cross-workspace jumps.
  - Split tab system: sessions, composer, and settings each get their own tabs (`perSession`); lazy placeholder restore across window reloads and extension updates; tab context actions and full-page reload.
  - Multi-window / multi-tab concurrency groundwork: extension-side SSE event proxy (works around the webview connection-pool ceiling), shared server instance and instance coordination, server auto start/stop, embed lifecycle protocol evolution.
  - Server management: version checks and upgrades against both a local folder and the npm registry, local-package install source.
  - Project-level config: `.pi/settings.json` editing, per-project enabled-model lists, composer drafts that survive restarts.
  - Independent distribution: the `@william_stone/pi-web-for-ide` npm package and this extension, no longer released as one bundle.
