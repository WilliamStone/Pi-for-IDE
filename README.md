# pi-code — Pi Web+ / pi for IDE

[中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

A web interface for the [pi coding agent](https://github.com/badlogic/pi-mono) that also embeds into VSCode/VSCodium as a first-class panel. Two deliverables ship from this repo:

| Deliverable | Name | Role |
|---|---|---|
| npm package | **`pi-web-for-ide`** | Enhanced pi-web. Runs standalone in any browser as **Pi Web+**; when a host embeds it with `?embed=<host>` it switches to **pi for IDE** host mode. CLI command: `pi-web`. |
| VSCode extension | **`pi-for-ide`** (`WilliamStone.pi-for-ide`) | Lightweight host shell (~190KB). Launches or connects to the globally installed package and adds IDE integration inside the webview. |

The package and the extension are independently installable and updateable — the extension carries no pi-web payload.

## Features

### pi-web core (standalone & embedded)

- Session management: browse, search, fork, and resume local pi sessions with real-time streaming chat
- Model & provider configuration: OAuth login, API keys, models.json editing, catalog refresh
- MCP server configuration, skills search/install, plugin enable/disable
- File preview, worktrees, terminal panel, i18n (en/zh-CN/ja/ru), light/dark themes, PWA
- `pi-web` CLI: `pi-web [--port N] [--hostname H] [--no-open]`, `status`, `stop`, `open`, `update`, `update-sdk`

### IDE integration (embed mode, VSCode host)

- **`@` file mention**: completion queries `vscode.workspace.findFiles` instead of the server filesystem
- **Right-click mention**: Explorer/editor context menus "在 pi for IDE 中提及" for files and selections
- **Active-file context injection**: the file you're viewing is injected into the system prompt (hidden marker — AI sees it, UI doesn't, nothing written to session files)
- **File review cards + inline diff + one-click revert**: per-turn cards list AI-modified files; revert restores code and removes the turn without touching git history (read-only git, no stash/commit)
- **Clipboard bridge**: copy/paste routes through `vscode.env.clipboard` inside the sandboxed iframe
- The built-in file tree/preview panels hide in host mode — VSCode's explorer and editor groups take over

Everything embed-specific is gated behind `?embed=<host>` — standalone browser use is a complete pi-web with the host bridge inert.

## Install & run

Requires Node.js ≥ 22.19.0.

### Standalone (Pi Web+)

```bash
npm install -g pi-web-for-ide   # or: npm i -g ./pi-web-for-ide-0.12.1.tgz (local tarball)
pi-web                          # serves http://127.0.0.1:3030, auto-opens browser
```

`PI_WEB_PASSWORD='long-random' pi-web` enables HTTP Basic Auth (user `pi`). The postinstall script links Turbopack external packages — make sure install scripts are allowed (pnpm does by default; for npm see the troubleshooting note in `docs/vscode-extension-deploy.md`).

### VSCode / VSCodium (pi for IDE)

1. Install the package globally (as above).
2. Install the extension: `code --install-extension vscode-extension/pi-for-ide-0.1.0.vsix` (VSCodium: `codium`).
3. Click the **pi for IDE** status-bar item, or run **pi for IDE: 打开** from the command palette.

The extension resolves the server entry in order: `piIde.executablePath` → bundled `resources/` (transitional) → `npm root -g` → `pi-web` PATH shim (pnpm/yarn/bun shims included) → `npx` fallback. After spawn it probes `GET /api/embed` and warns if the connected server lacks the IDE patch.

| Setting | Description |
|---|---|
| `piIde.executablePath` | Absolute path to a pi-web entry (standalone `server.js` or `bin/pi-web.js`). |
| `piIde.package` | Package name for global lookup / npx fallback (default `pi-web-for-ide`). |
| `piIde.workspaceRoot` | Project dir passed to pi-web (`cwd`); defaults to the workspace folder. |
| `piIde.openBeside` | Open the panel in the adjacent column (default true). |
| `piIde.port` | Preferred starting port (default 3030; auto-increments when busy). |

Full deploy & troubleshooting guide: [`docs/vscode-extension-deploy.md`](./docs/vscode-extension-deploy.md).

## Architecture

```
pi-for-ide extension (VSCode)
  ├── piIdeServer        resolves entry → spawns pi-web → probes /api/embed
  ├── webviewProvider    <iframe src="…/?embed=vscode"> + readiness gate
  └── bridge             page ↔ VSCode API:
                         openFile / completeAt / clipboard / snapshots /
                         revert / activeEditor
pi-web-for-ide (external package)
  └── embed host abstraction (?embed=<host>) — host-agnostic, VSCode is
      the first adapter; JetBrains-class hosts can plug in later
```

## Upstream & credits

- **[pi](https://github.com/badlogic/pi-mono)** (badlogic): the coding agent itself — the engine every layer drives.
- **[pi-web](https://github.com/agegr/pi-web)** (agegr): the Next.js web UI for pi — this repo's upstream. The entire web application (sessions UI, streaming chat, model/MCP/skills/plugin management, terminal, PWA) is theirs; we merge upstream releases regularly rather than re-implementing them.
- **[pi-code](https://github.com/wangjinxin613/pi-code)** (wangjinxin613): the original IDE integration — introduced the VSCode extension, the embed host mode (`?embed`), the page↔host bridge, file review/revert, and active-file injection. This repo forks from it.
- **This repo (WilliamStone/pi-code)**: on top of pi-code — decoupled packaging (external `pi-web-for-ide` npm package + thin extension), brand layering (Pi Web+ / pi for IDE), pnpm/PATH-shim server resolution, standalone MCP fix, server/webview lifecycle fixes, and continued upstream sync. See `docs/decoupling-plan.md`.

## Development

```bash
npm install                 # deps
npm run build               # next build (browser app)
node scripts/prepare-standalone.js   # standalone assembly used by npm pack
npm pack                    # → pi-web-for-ide-<ver>.tgz
cd vscode-extension && npm run compile && npm run package   # → pi-for-ide-<ver>.vsix
bash scripts/sync-upstream.sh vX.Y.Z   # merge an upstream pi-web tag
```

`PI_WEB_STANDALONE=1` flips the build into Next standalone output; `scripts/` contains the upstream-sync and patch-export toolchain (`sync-upstream.sh`, `export-patches.sh`, `apply-to.sh`).
