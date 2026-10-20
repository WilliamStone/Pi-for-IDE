# Pi for IDE — VS Code extension

![Pi for IDE screenshot](screen.png)

**Pi for IDE** puts the full Pi Web+ interface — chat with the pi coding agent, session history, model and skill configuration — inside a VS Code panel, plus a set of editor-native integrations: real diffs, file mentions, and one-click revert.

The web app itself stays a normal standalone product: the same server also runs in your browser, and the extension and web app upgrade independently.

## What you get

### The whole pi web UI, in your editor

Click the **Pi icon in the editor title bar** (or run `Pi for IDE: Open`) — the panel opens beside your code with the complete web UI: session browsing, streaming output, tool-call views, branch navigation, themes, i18n.

- **No setup needed**: on first use the extension can download and manage the server component itself — just open the panel. Prefer the CLI? `pnpm add -g @william_stone/pi-web-for-ide` gives you `pi-web-for-ide` on PATH; the extension uses that copy automatically.
- **One server, shared**: if a compatible server is already running (another window, or one you started yourself), the panel connects to it instead of starting a duplicate — one shared view of your sessions and data. When it connects to an existing instance, a notice tells you which one.
- **Clear problems, clear fixes**: if the connected server can't provide IDE integration (wrong package, outdated version, incomplete install), you get a specific warning telling you what to run — never a silent blank panel.
- **Always reachable**: the panel's **Open in Browser** button opens the same server in your system browser.

### Works with your workspace

- **`@` mentions**: type `@` in the composer and pick files from your workspace — powered by VS Code's own file search.
- **Right-click**: *Mention This File* / *Mention This Code* from the editor and Explorer context menus.
- **Clipboard just works**: copy/paste inside the panel behaves like the rest of the editor.
- **Sees what you see**: the file you're currently viewing is quietly shown to the agent — the composer displays a hint so you always know which file it has in context. Nothing is written to your session files.

### Review and undo agent changes

After every turn, a **File review** card lists the files the agent changed:

- **Open diff in editor** — a native two-sided VS Code diff of that turn's changes.
- **Open file in editor** — jump straight to the file.
- **Revert this turn** — hover the user message and hit *Revert*: every file the turn touched goes back to its pre-turn state, and that turn's conversation is removed. Middle-of-history reverts don't lose later turns. Always asks first.
- **Your git stays untouched** — no stash, no commits, nothing created in your repository.

### Looks after itself

- **Cleans up**: a server started by the extension exits on its own shortly after the last window or page disconnects — nothing left running overnight.
- **You're in control**: `Pi for IDE: Start Server` / `Stop Server` any time; `Pi for IDE.autoStart` can also bring it up with the editor.
- **Upgrades don't wedge**: upgrading the package while a server is running fails early with clear stop-and-retry instructions instead of a broken half-install.

## Commands

| Command | What it does |
|---|---|
| `Pi for IDE: Open` | Open the Pi for IDE panel |
| `Pi for IDE: Show Panel` | Reveal an already-created panel |
| `Pi for IDE: Start Server` | Start the local server |
| `Pi for IDE: Stop Server` | Stop the server this window manages |
| `Pi for IDE: Open in Browser` | Open the same UI in your system browser |
| `Pi for IDE: Mention This File` | Mention the active file in the composer |
| `Pi for IDE: Mention This Code` | Mention the current selection |
| `Pi for IDE: Upgrade Server Component` | Update the server package |
| `Pi for IDE: Manage Server Versions` | Choose which installed version runs |

## Settings

| Setting | What it controls |
|---|---|
| `Pi for IDE.executablePath` | Point at a specific server build. Empty → automatic. |
| `Pi for IDE.package` | Which package provides the server (default `@william_stone/pi-web-for-ide`). |
| `Pi for IDE.workspaceRoot` | Which folder the agent works in. Empty → current workspace. |
| `Pi for IDE.openBeside` | Open the panel next to your code (default on). |
| `Pi for IDE.port` | Preferred port (default `3030`; auto-bumps when taken). |
| `Pi for IDE.autoStart` | Start the server when the editor loads (default off). |
| `Pi for IDE.autoStop` | Let the spawned server exit after everyone disconnects (default on). |
| `Pi for IDE.autoStopAfterSec` | How long silence lasts before self-stop, min 90 (default `90`). |
| `Pi for IDE.checkForUpdates` | Notify when a newer server package exists (default on). |

## Notes

- Standalone browser use is unaffected — the same package does both jobs.
- The panel can't use browser dialogs (`alert`/`confirm`); confirmations appear inside the page.
- If you want a dedicated server that's never shared, set `Pi for IDE.port` outside 3030–3039.
- Revert restores what the turn changed; edits you made yourself afterwards are left alone.
