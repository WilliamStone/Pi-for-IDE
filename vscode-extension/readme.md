# Pi for IDE / Pi Web+

[中文文档](./docs/README.zh-CN.md) | [日本語](./docs/README.ja.md) | [Русский](./docs/README.ru.md)

Embeds the [pi agent](https://github.com/earendil-works/pi)'s web UI into VSCode/VSCodium as a first-class panel, with an IDE-workflow integration layer on top.

This repo ships two independently installable and updateable deliverables:

| Deliverable | Name | Role |
|---|---|---|
| VSCode extension | **`pi-for-ide`** (`WilliamStone.pi-for-ide`) | **The product**. A lightweight host shell (~190KB): launches/connects to a pi-web server and layers IDE integration inside the webview. |
| npm package | **`@william_stone/pi-web-for-ide`** | The substrate. pi-web plus an IDE adaptation layer; IDE features activate when a host embeds it via `?embed=<host>`. CLI command: `pi-web-for-ide` (deliberately distinct from upstream's `pi-web` so the two can coexist). |

The relationship: `@william_stone/pi-web-for-ide` is "pi-web + a host-adaptation layer". Standalone it behaves like stock pi-web (brand slot shows **Pi Web+**); IDE features activate only in embed mode. The extension carries no pi-web payload — the web app installs and upgrades separately.

## IDE integration (the core)

Active only when embedded in VSCode/VSCodium via `?embed=vscode`:

- **`@` file mention**: completion queries `vscode.workspace.findFiles` (workspace index, not server filesystem)
- **Right-click mention**: Explorer/editor context menus "Mention in Pi for IDE" for files and selections
- **Active-file context injection**: the file you're viewing is injected into the system prompt as a hidden marker (AI-visible, UI-hidden, never persisted)
- **File review cards + inline diff + one-click revert**: per-turn cards list AI-modified files; reverting restores code and removes the turn — read-only git, no stash/commit
- **Clipboard bridge**: copy/paste inside the sandboxed iframe routes through `vscode.env.clipboard`
- **UI trim**: pi-web's file tree/preview panels hide in host mode — VSCode's explorer and editor groups take over

All pi-web capabilities (session management, streaming chat, model/OAuth/MCP/skills/plugin config, terminal, i18n, themes, PWA) remain available in both modes.

## Install & use

Requires Node.js ≥ 22.19.0.

**Step 1 — install @william_stone/pi-web-for-ide globally (pnpm recommended):**

```bash
pnpm add -g @william_stone/pi-web-for-ide   # npm i -g works too; local: pnpm i -g ./pi-web-for-ide-0.12.1.tgz
```

> Why pnpm: it surfaces the package's postinstall for interactive approval (`pnpm approve-builds`) — needed to link the standalone external packages. npm's script blocking has no equivalent escape hatch. Fallback anyway: `pi-web` self-heals the links on startup (≥0.12.2); see `docs/vscode-extension-deploy.md`.

**Step 2 — install the extension and open:**

```powershell
code --install-extension vscode-extension/pi-for-ide-0.1.0.vsix    # VSCodium: codium
```

Then click the **Pi for IDE** status-bar item or run **Pi for IDE: Open**. On first use, configure a model/API key via the panel's Settings → Models (shares `~/.pi/agent/` with the pi CLI).

**Optional: standalone mode.** The installed package also runs in a plain browser like stock pi-web (brand shows Pi Web+):

```bash
pi-web-for-ide            # http://127.0.0.1:3030; see pi-web-for-ide --help for --port/--hostname/--no-open
pi-web status|stop|open|update|update-sdk
```

## Settings (extension)

| Setting | Description |
|---|---|
| `Pi for IDE.executablePath` | Absolute path to a pi-web entry (standalone `server.js` or `bin/pi-web.js`); usually left empty for auto-resolution. |
| `Pi for IDE.workspaceRoot` | Project dir for sessions (`cwd`); defaults to the workspace folder. |
| `Pi for IDE.openBeside` | Open the panel in the adjacent column (default true). |
| `Pi for IDE.port` | Preferred starting port (default 3030; auto-increments when busy). |
| `Pi for IDE.package` | Package name for managed-runtime and global lookup (default `@william_stone/pi-web-for-ide`). |

Can't connect, blank panel, save errors: see [docs/vscode-extension-deploy.md](./docs/vscode-extension-deploy.md).

## Upstream & credits

- **[pi](https://github.com/earendil-works/pi)** (earendil-works): the underlying coding agent.
- **[pi-web](https://github.com/agegr/pi-web)** (agegr): the Next.js web UI for pi — this repo's direct upstream; the entire web application is theirs, and we merge upstream releases rather than re-implementing.
- **[pi-code](https://github.com/wangjinxin613/pi-code)** (wangjinxin613): the original IDE integration — the VSCode extension, embed bridge, file review/revert, and active-file injection all originate there; this repo forks from it.
- **[pi-for-ide](https://github.com/WilliamStone/Pi-for-IDE) (This Repo)**: on top of pi-code — decoupled packaging (external npm package + thin extension), brand layering (Pi Web+ / Pi for IDE), pnpm/PATH-shim server resolution, the standalone MCP fix, server/webview lifecycle fixes, and continued upstream sync. See `docs/decoupling-plan.md`.

## For developers

Server-entry resolution order (extension side): `Pi for IDE.executablePath` → bundled `resources/` (transitional) → `npm root -g` → `pi-web-for-ide` PATH shim (only our package's own command name is accepted — an upstream `pi-web` shim is never launched) → versioned managed runtime under `globalStorage` (auto-installed; see [docs/agents/managed-runtime.md](./docs/agents/managed-runtime.md)). After spawn it probes `GET /api/embed` and warns when the connected server lacks the IDE patch.

Architecture:

```
pi-for-ide extension (VSCode)
  ├── piIdeServer        resolve entry → spawn pi-web → probe /api/embed
  ├── webviewProvider    <iframe src="…/?embed=vscode"> + readiness gate
  └── bridge             page ↔ VSCode API: openFile / completeAt /
                         clipboard / snapshots / revert / activeEditor
@william_stone/pi-web-for-ide (external package)
  └── embed host abstraction (?embed=<host>) — host-agnostic protocol;
      VSCode is the first adapter, JetBrains-class hosts can follow
```

Build & sync:

```bash
npm install                 # deps
npm run build               # next build (browser app)
node scripts/prepare-standalone.js   # standalone assembly used by npm pack
npm pack                    # → @william_stone/pi-web-for-ide-<ver>.tgz
cd vscode-extension && npm run compile && npm run package   # → pi-for-ide-<ver>.vsix
bash scripts/sync-upstream.sh vX.Y.Z   # merge an upstream pi-web tag
```

Do not run `next build` or `npm run build` during normal development. It writes to `.next/` and can interfere with the development server; leave builds for release work.

`PI_WEB_STANDALONE=1` flips the build into Next standalone output; `scripts/` holds the upstream-sync and patch-export toolchain (`sync-upstream.sh`, `export-patches.sh`, `apply-to.sh`).

Contributor guides: [Internationalization](./docs/i18n.md) and [Release process](./docs/release.md).

## Repository Layout

```text
app/               Next.js UI and API routes
components/        React UI components
hooks/             Client state and interaction hooks
lib/               Session, agent, model, file, Git, and security logic
public/            Static assets and PWA files
bin/               npm CLI entrypoint and launch option parsing
vscode-extension/  The pi-for-ide VSCode/VSCodium extension shell
docs/              Focused user and contributor guides
demo/              Static browser demo published to GitHub Pages (see demo/README.md)
```

See [AGENTS.md](./AGENTS.md) for the architecture notes and detailed file map.

## License

[MIT](./LICENSE)
