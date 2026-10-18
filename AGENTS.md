# Pi Web+ - Development Notes

## Quick Start

```bash
npm run dev   # port 30141
```

Typecheck: `node_modules/.bin/tsc --noEmit` · Lint: `npm run lint`

**Never run `next build` during dev**: it pollutes `.next/` and breaks `npm run dev`.

### Language policy (user-facing strings)

This is an internationalized project — every string an end user can see follows one rule:

- **Where the platform supports i18n, use it.** VSCode manifest strings (settings descriptions, command titles, extension description) go through `%key%` placeholders resolved by `package.nls.json` (English default) + `package.nls.zh-cn.json`. Brand names (`Pi for IDE`, `Pi Web+`, `displayName`) are never translated.
- **Where it does not, write English.** Runtime strings everywhere — extension notifications/status bar/output logs/webview shell/bridge messages, and package-side CLI output (`bin/pi-web*.js` console/error text users can see in the log channel) — are English-only literals; do not add Chinese (or other locale) user-facing strings.
- Code comments are developer-facing and exempt; this rule covers UI surface only.

### Fork delta discipline (upstream merges)

Every in-place edit inside an upstream-owned file is a future merge conflict. Keep the delta minimal:

- Embed/IDE features live in our own files first: `lib/embed/**`, `components/embed/**`, `hooks/useEmbed*`, `bin/pi-web-standalone.js`, `vscode-extension/**`.
- When an upstream file must change, prefer **adding a call site** (a hook call, an options field, a conditional branch) over changing existing signatures or logic.
- When a signature genuinely must change (e.g. `getInstallKind` needing `name`), keep the change small and expect to re-resolve it at every sync.
- Upstream test files will assume POSIX; on Windows failures, apply the playbook in [upstream-sync.md](docs/agents/upstream-sync.md) rather than diagnosing from scratch.

### Dev server troubleshooting

- First run `lsof -nP -iTCP:30141 -sTCP:LISTEN` and reuse a healthy Pi Web process. A second `next dev` on another port is no workaround: both contend for `.next/dev/lock`.
- A browser-only `Module ... factory is not available` overlay usually means that tab has a stale Turbopack/HMR graph, not a broken server or source. Use the browser's explicit reload, then compare the server log and a direct HTTP/API request.
- Restart only when the failure reproduces from a fresh page and the server-side checks fail too: stop that exact dev process gracefully, move `.next` into a `mktemp -d` backup, restart with `npm run dev`.
- Never fall back to `next dev --webpack`: the dev graph can fail on `undici` imports such as `node:console`. Development uses Turbopack.
- `next dev` may append a generated `BEGIN:nextjs-agent-rules` block to `AGENTS.md`. It is tooling output: check `git status` and keep it out of unrelated commits.

### Upgrading pi

pi's packages depend on each other with `^` ranges, and the published pi-web's dependencies resolve afresh on install (no lockfile ships). Install every `@earendil-works/*` package the tree holds, the SDK's own dependencies included (`pi-codemode`, `pi-mcp`, `pi-telemetry`, …), with `npm install --save-exact`, so npm reuses those exact versions for the SDK's ranges. `lib/pi-packages.test.mjs` fails on any pi package that is not pinned that way; pi-web 0.12.0 pinned four, and installs after pi 1.2.0 paired pi-coding-agent 1.1.0 with pi-codemode 1.2.0.

---

## Architecture

- **Browsing** (read-only, no AgentSession): `GET /api/sessions` lists `~/.pi/agent/sessions/`; `GET /api/sessions/[id]` reads the `.jsonl` through SDK `SessionManager` helpers and `lib/session-reader.ts`, or an open wrapper's in-memory `SessionManager`. `GET /api/agent/running` snapshots the running ids.
- **Sending**: `POST /api/agent/[id]` → `startRpcSession()` (`lib/rpc-manager.ts`) creates the AgentSession in-process (`createAgentSessionFromServices()`); `session.send(cmd)` → `session.prompt()`.
- **Events**: `GET /api/agent/[id]/events` streams SSE `data: {...}` from `session.onEvent()`, fed by `session.subscribe()`.
- **Product scope**: a light web wrapper around pi, not an IDE or a platform of its own. Before adding a feature, check the out-of-scope list in [CONTRIBUTING.md](CONTRIBUTING.md).
- **Extension compatibility (principle)**: extensions written for the pi CLI must behave the same here. Fix display problems in the web client; never add pi-web-only options or fields to the extension API (`ctx.ui.*` options, `extension_ui_request`). pi's TUI (`node_modules/@earendil-works/pi-tui`) is the reference for what an extension asking for something means.

---

## File map & topic notes

File-by-file reference (`app/api/`, `lib/`, `components/`, `hooks/`) and the
per-area design notes live in [docs/agents/index.md](docs/agents/index.md).
Before editing, look up every file a change touches there and read its note.
Design decisions and traps go in the area's note — register new notes in the
index, not here.

---

## Old Safari (iOS 16.2)

- `/` renders entirely on the client, so one script chunk the browser cannot parse is a blank page. Next 16 targets Safari 16.4+; the `browserslist` in `package.json` lowers Safari and iOS to 16.2 so SWC turns class `static {}` blocks into private static fields. That covers Next's client runtime; other node_modules keep their syntax unless listed in `transpilePackages` (mermaid and `@mermaid-js/parser` are, for their lazy diagram chunks). Keep the other browserslist entries at Next's defaults.
- Never write a RegExp lookbehind (`(?<=`, `(?<!`) in client code: SWC cannot downlevel it and Safari parses it only from 16.4. `lib/markdown.ts` emulates its leading lookbehinds with `replaceNotPrecededBy()`. A lookbehind built at runtime (`new RegExp("(?<=…)")` in `try`) fails only when run; that is how `lib/gfm-autolink-email-loader.cjs` fixes `mdast-util-gfm-autolink-literal`'s email regex. The loader is registered for webpack and Turbopack in `next.config.ts` and fails the build if that regex changes upstream.

## Pi Session File Format

Location: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`SessionContext.entryIds[]` parallels `messages[]`: each displayed message's `.jsonl` entry id, used for fork and navigate_tree.

## CSS Variables (`app/globals.css`)

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```

## Git 提交节奏

- 不边改边提交：一个工作内容完成并可验收时再提交（如确定发布时、切换工作项时收上一轮）。
- 同一工作的多个连续提交用 squash 合并成一个后再推。
- 一切公开发布（npm stage/publish、ovsx/vsce publish、unpublish/delete）先提方案经用户审批，不擅自执行。
