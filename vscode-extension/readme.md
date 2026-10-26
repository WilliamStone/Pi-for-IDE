# Pi for IDE — VS Code extension

![Pi for IDE screenshot](screen.png)

[**Pi for IDE**](https://github.com/WilliamStone/Pi-for-IDE) puts the full [pi-web](https://github.com/agegr/pi-web) interface inside a VS Code panel — chat with the pi coding agent, browse session history, configure models and skills — plus a set of editor-native integrations: a real sessions sidebar, true diffs, `@` file mentions, one-click revert, and IDE-aware window routing.

The web app stays a standalone product: the same server runs in your browser, and the extension and web app upgrade independently.

## What you get

### A real sessions sidebar

The **Pi Sessions** activity view is a native tree, not a web view — fast, keyboard-friendly, and workspace-aware:

- **Grouped by project** (or a flat *Recent* mode) with live **running** / **awaiting input** icons on sessions, pinned projects and sessions pinned to the top.
- **Session actions**: open, open in the full page, rename, pin, archive, fork, delete — plus directory actions: *reveal in Explorer*, *open workspace in new window*, *open in integrated terminal*.
- **Project actions**: pin, rename, start a new session, or jump to its workspace window.
- **Workspace-aware**: filter to the current workspace with one click; sessions and projects that live in *other* workspaces get a distinct shortcut-style icon, sink below same-workspace groups, and carry a floating *Open in Workspace Window* button — it focuses that workspace's window if one exists (creates it otherwise) and hands the session over, so the destination window opens it for you. Clicking a session directly still opens it here.
- **Startup is visible**: while the server resolves/starts you see the stage inside the view instead of an ambiguous empty list; every milestone lands in a timestamped output-channel timeline.
- **Awaiting input**: sessions waiting on you get a badge in the tree, a status-bar count that cycles to the next one when clicked, and an optional toast (`Pi for IDE.notifyAwaiting`).

### The whole pi web UI, in your IDE

Click the **Pi for IDE button** in the bottom-right of the status bar (or run `Pi for IDE: Open`) — the panel opens beside your code: streaming output, tool-call views, branch navigation, themes, multi-language UI.

- **Works out of the box**: on first use the extension can download and manage the server component itself — just open the panel. Prefer the CLI? `pnpm add -g @william_stone/pi-web-for-ide` puts `pi-web-for-ide` on PATH and the extension picks it up automatically.
- **Per-session tabs**: give every session its own tab (`perSession`), or keep one shared tab (`shared`) — `Pi for IDE.sessionTabs`.
- **One server, shared**: when a compatible server is already running (another window, or one you started), the panel connects to it instead of starting a duplicate — one shared view of sessions and data.
- **Clear diagnostics**: if the connected server can't provide IDE integration (wrong package, outdated version, incomplete install), you get a specific warning with the exact fix command — never a silent blank panel.
- **Always reachable**: the panel's **Open in Browser** button opens the same server in your system browser.

### Feels native to your workspace

- **`@` mentions**: type `@` in the composer to pick workspace files — powered by VS Code's own file search.
- **Right-click mentions**: *Mention This File* / *Mention This Code* on the editor and Explorer context menus.
- **Clipboard just works**: copy/paste inside the panel behaves like everywhere else in the editor.
- **Active-file awareness**: the file you're viewing is quietly placed in the agent's context — the composer shows a hint so you always know which file it's looking at.
- **IDE shortcuts stay live**: with focus inside the panel, chords the app doesn't consume (Ctrl+J, Ctrl+B, Ctrl+\`, F-keys…) are resolved by VS Code itself — your own keybindings and `when` clauses apply exactly as a normal keypress. The app's own shortcuts keep priority.

### Review and undo agent changes

After each turn, a **File review** card lists the files the agent touched:

- **Open diff in editor** — a native two-sided VS Code diff of that turn's changes, even when the agent edited a file outside the session's own folder.
- **Open file in editor** — jump straight to the file.
- **Revert this turn** — hover a user message and hit *Revert*: every file the turn touched returns to its pre-turn state, and the turn's conversation entries are removed. Reverting a middle turn never loses later turns. Always confirmed first.

### One server for every window

- **Cross-window coordination**: windows serialize server checks, spawns, and upgrades through a shared lock — the first window does the work, siblings attach to the result.
- **Shutdown with consent**: a stop request is refused while another window's panel is still connected — closing *your* window never kills the server out from under a sibling.
- **Clean handoffs**: after a server restart or upgrade, open panels in other windows switch to the new instance on their own; a reminder tells you browser tabs need one manual reload.

### Looks after itself

- **Leaves no trace**: a server started by the extension exits on its own shortly after the last window or page disconnects — nothing left running overnight.
- **You're in control**: `Pi for IDE: Start Server` / `Stop Server` any time; `Pi for IDE.autoStart` can also bring it up with the editor.
- **Upgrade your way**: npm registry or a local build — point `Pi for IDE.localPackage` at a `.tgz` file or a folder of builds (the newest wins, told apart by build timestamp, not just version). `Pi for IDE.installSource` picks `auto` / `prefer-remote` / `local` / `registry`. Upgrade prompts show the full comparison — sources, versions, build stamps — with a one-click **Install** and **Details…** for the complete table.
- **Upgrades don't wedge**: upgrading the package while a server is running tells you to restart first instead of leaving a broken half-install.

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

Session and project actions (open, rename, pin, archive, fork, delete, directory and window routing, workspace filter, view-mode switch) live on the **Pi Sessions** view's context menus.

## Settings

| Setting | What it controls |
|---|---|
| `Pi for IDE.autoStart` | Start the server when the editor loads (default off). |
| `Pi for IDE.autoStop` | Let the spawned server exit after everyone disconnects (default on). |
| `Pi for IDE.autoStopAfterSec` | Silence before self-stop, min 90s (default `90`). |
| `Pi for IDE.port` | Preferred port (default `3030`; auto-bumps when taken). |
| `Pi for IDE.workspaceRoot` | Which folder the agent works in. Empty → current workspace. |
| `Pi for IDE.sessionTabs` | `perSession` gives each session its own tab; `shared` keeps one (default `perSession`). |
| `Pi for IDE.openBeside` | Open the panel in the adjacent column (default on); off → the active column. |
| `Pi for IDE.notifyAwaiting` | Toast when a session starts waiting for your input (default off). |
| `Pi for IDE.showOpenInBrowser` | Show the Open-in-Browser button in the panel top bar (default on). |
| `Pi for IDE.executablePath` | Point at a specific server build. Empty → automatic. |
| `Pi for IDE.package` | Which package provides the server (default `@william_stone/pi-web-for-ide`). |
| `Pi for IDE.checkForUpdates` | Notify when a newer server package exists (default on). |
| `Pi for IDE.localPackage` | Path to a local server tarball, or a folder of `.tgz` builds — the newest wins (default empty). |
| `Pi for IDE.installSource` | Upgrade source: `auto`, `prefer-remote`, `local`, `registry` (default `auto`). |

## Notes

- Runs standalone in a browser just like upstream pi-web — one package, two uses.
- Want a dedicated server that's never shared? Set `Pi for IDE.port` outside 3030–3039.
- Revert restores each touched file to its pre-turn state; files you manually edited after the turn are skipped with a notice instead of being overwritten.
