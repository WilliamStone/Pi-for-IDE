# Index — file map & topic notes

Lookup-only reference. `AGENTS.md` stays lean on purpose — consult this
index before editing; register new notes here, not there.

## Topic notes

Design decisions and traps live here in `docs/agents/`, one note per area.
Read every note whose files a change touches before making it.

- [sessions.md](sessions.md): AgentSession lifecycle and shutdown, fork vs in-session branching, the sidebar's on-disk Fork, session file rewrites, toolCall normalization, a run's message keys across the file read, SSE reconnect and tool events, transcript system / usage / context-edit entries, running-state polling, custom-message collapsing, streamed chunks re-rendering only the reply, streaming markdown block by block, long thinking rendered in pieces, a finished turn's duration, history caches (tool-result images, subagent runs, session views) and deferred code highlighting with Prism languages loaded on demand, the session sidebar (toolbar row and its brand, project groups, their order and display names, pins, archive, new-session project adoption, the files below the sessions or in a tab), the project/worktree bar above a fresh composer (the header: brand, then the bar) and what it carries across the remount, exported HTML, the extension status bar and its `command:` buttons, cache and cost notices (`showCacheMissNotices`). Files: `lib/rpc-manager.ts`, `lib/session-reader.ts`, `lib/session-fork*.ts`, `lib/session-delete.ts`, `lib/normalize.ts`, `lib/message-keys.ts`, `lib/session-tree.ts`, `lib/session-ui-state*.ts`, `lib/sidebar-prefs.ts`, `lib/sidebar-actions.ts`, `lib/session-links.ts`, `lib/new-session-context.ts`, `hooks/useAgentSession.ts`, `hooks/useSessionUiState.ts`, `hooks/useSidebarMotion.ts`, `hooks/useGroupDrag.ts`, `hooks/useFilesPlacement.ts`, `hooks/useResizablePanel.ts`, `app/api/agent/**`, `app/api/sessions/**`, `components/SessionSidebar.tsx`, `components/PiWebTitle.tsx`, `components/SessionTree.tsx`, `components/SidebarMenu.tsx`, `components/SidebarToast.tsx`, `components/SidebarIcons.tsx`, `components/ProjectWorktreePicker.tsx`, `components/NewSessionContextBar.tsx`, `components/WorktreeCreateForm.tsx`, `handleNewSession`, `handleSelectSession` and the bar's handlers in `components/AppShell.tsx`, `components/BranchNavigator.tsx`, `components/MessageView.tsx`, `lib/message-display.ts`, `components/MarkdownBody.tsx`, `lib/markdown-blocks.ts`, `lib/streaming-message.ts`, `hooks/useStreamingSelector.ts`, `lib/turn-duration.ts`, `components/MermaidBlock.tsx`, `lib/highlight-queue.ts`, `lib/prism-languages.ts`, `hooks/usePrismLanguages.ts`, `lib/session-view-cache.ts`, `components/CodemodeToolView.tsx`, `components/ExtensionStatusBar.tsx`, `components/ExtensionWidgets.tsx`, `lib/transcript-notices*.ts`, `components/TranscriptNotices.tsx`, `app/api/cache-miss-notices/**`.
- [tools.md](tools.md): tool presets and Chat only, exact system prompts, tool exposure, the codemode / tool-search / mcp built-ins, the read-only MCP policy, the Code mode and PowerShell `defaultTools` switches. Files: `lib/tool-presets.ts`, `lib/tool-preset-preference.ts`, `lib/chat-only.ts`, `lib/exact-system-prompt.ts`, `lib/builtin-extensions.ts`, `lib/mcp-read-only-policy.ts`, `lib/codemode-settings.ts`, `lib/powershell-settings.ts`, `lib/global-settings-file.ts`, `app/api/agent/new/route.ts`, `app/api/tools/settings/route.ts`, tool selection in `lib/rpc-manager.ts`.
- [mcp-runtime.md](mcp-runtime.md): the per-session MCP host (when servers register and connect, reported states, trust read on every sync, idle release); `/mcp` in the composer. Files: `lib/mcp-host.ts`, `lib/mcp-transport.ts`, `lib/mcp-status.ts`, `lib/mcp-command.ts`, `lib/mcp-config-key.ts`, MCP wiring in `lib/rpc-manager.ts` and `lib/builtin-extensions.ts`, `/mcp` handling in `hooks/useAgentSession.ts`.
- [mcp-settings.md](mcp-settings.md): Settings › MCP reads without running anything, masking, the trust dialog's server list, row states, notices, Code mode choice, trust from Settings, Escape stacking, every `mcp.json` write and undo. Files: `app/api/mcp/route.ts`, `app/api/project-trust/route.ts`, `lib/mcp-config-read.ts`, `lib/mcp-config-file.ts`, `lib/mcp-override.ts`, `lib/mcp-undo.ts`, `lib/mcp-secrets.ts`, `lib/mcp-server-display.ts`, `lib/mcp-json-error.ts`, `lib/project-trust.ts`, `lib/regular-file.ts`, `lib/stacked-dialog.ts`, `lib/settings-navigation.ts`, `components/McpConfig.tsx`, `components/mcp-config-helpers.ts`, `components/ProjectTrustDialog.tsx`, `components/SettingsPanel.tsx`.
- [mcp-test-sign-in.md](mcp-test-sign-in.md): Settings › MCP Test (route checks, bounded connection, `!command` queue, redaction, status store) and OAuth sign-in / sign-out. Files: `app/api/mcp/test/**`, `app/api/mcp/sign-in/**`, `lib/mcp-test.ts`, `lib/mcp-entry-request.ts`, `lib/mcp-status.ts`, `lib/mcp-sign-in.ts`, `lib/mcp-sign-out.ts`, `components/McpSignIn.tsx`, `components/mcp-sign-in-helpers.ts`, `components/OAuthPastePanel.tsx`.
- [mcp-add.md](mcp-add.md): Settings › MCP add (paste re-parsed on the server, host-variable confirmation, literal secrets kept global, fresh-folder trust, the add pane) and the paste importer's escaping and grammars. Files: `lib/mcp-add.ts`, `lib/mcp-import*.ts`, `lib/shell-words.ts`, fresh-folder trust in `lib/project-trust.ts`, `components/McpAddServer.tsx`, `components/mcp-add-helpers.ts`, the `add` action of `app/api/mcp/route.ts`.
- [models.md](models.md): default model and reasoning level, providers registered at session_start, mid-run reasoning changes, remote provider catalogs, `enabledModels` scoping and minimal edits, managed models' context-window overrides, provider auth listing and credentials, the extension-loaded runtime those routes share. Files: `app/api/models/**`, `app/api/models-config/**`, `app/api/auth/**`, `lib/model-runtime.ts`, `lib/default-preferences.ts`, `lib/model-scope.ts`, `lib/enabled-models*.ts`, `lib/model-context.ts`, `lib/model-catalog-refresh.ts`, `lib/deferred-provider-models.ts`, `lib/provider-listing*.ts`, `components/ModelsConfig.tsx`, `components/EnabledModelsSection.tsx`, `components/ModelContextWindow.tsx`, `components/ModelSelector.tsx`, `components/SelectorRow.tsx`.
- [files-and-access.md](files-and-access.md): worktrees and project grouping, the file access allow-list (the `/api/files` security boundary), file tree visibility and its open directories per folder, uploads and chat file drops, the source view's languages by extension, the CSV/TSV table view, web password throttling. Files: `app/api/files/**`, `app/api/cwd/**`, `app/api/worktrees/**`, `app/api/file-index/**`, `app/api/web-auth/**`, `proxy.ts`, `lib/path-security.ts`, `lib/file-access.ts`, `lib/linked-directory.ts`, `lib/session-file-references*.ts`, `lib/file-tree-visibility.ts`, `lib/file-tree-expansion.ts`, `lib/file-upload-client.ts`, `lib/worktree.ts`, `lib/paths.ts`, `lib/auth-throttle.ts`, `components/ProjectWorktreePicker.tsx`, `components/NewSessionContextBar.tsx`, `components/FileExplorer.tsx`, `lib/delimited-table.ts`, `components/DelimitedTable.tsx`, the table branch of `components/FileViewer.tsx`, `hooks/useDragDrop.ts`.
- [settings-ui.md](settings-ui.md): General's sidebar file-browser choice, Plugins and Skills routes, sidebar group switches, the shared `SettingsUi` blocks every settings panel and add pane uses. Files: `app/api/plugins/**`, `app/api/skills/**`, `lib/skills-service.ts`, `components/SettingsUi.tsx`, `components/settings-ui-helpers.ts`, `components/SkillsConfig.tsx`, `components/PluginsConfig.tsx`, `hooks/useFilesPlacement.ts`; also before adding a settings section or add pane.
- [subagents.md](subagents.md): the built-in subagent setting, profiles and their files, run status, completion notifications, the subagent viewer tab. Files: `lib/subagent*.ts`, `app/api/subagents/**`, `components/AgentsConfig.tsx`, `components/SubagentViewer.tsx`, `components/subagent-viewer-state.ts`.
- [upstream-sync.md](upstream-sync.md): the merge SOP — read before every `sync-upstream.sh` run (keep-ours file list, post-merge checks, Windows test-failure playbook).
- [turn-revert.md](turn-revert.md): turn/file revert design — rewind-to-point vs excise-record, entry-level granularity, effect-based capture via watcher + shadow store, attribution trust tiers (declared/sole-observer/ambient). Read before touching `lib/turn-revert.ts`, `lib/file-changes.ts`, `lib/embed/turn-snapshot.ts`, `app/api/sessions/[id]/revert-turn/`, revert/snapshot handlers in `vscode-extension/src/bridge.ts`.
- [deploy.md](deploy.md): 打包/部署/实机验证手册——停服务三档（命令/PID/孤儿）、全局安装前的清场、验证清单。改打包脚本、部署行为、bridge/fs 侧链路时读。
- [backlog.md](backlog.md): 1.0.x 之后的产品 backlog——工作区过滤、原生边栏、start 超时解耦、回退演进。
- [embed-protocol.md](embed-protocol.md): the embed handshake contract — protocol level vs capability registry (namespaced keys, register-before-ship), and lifecycle sovereignty (watchdog armed only on extension-spawned servers; presence = heartbeat, open SSE or API poll; attach-not-adopt; sleep forgiveness via tick drift; turn-revert semantics). Read before touching `app/api/embed/**`, `app/api/sessions/[id]/revert-turn/`, `lib/embed/**`, `lib/file-changes.ts`, `lib/brand.ts`, `components/embed/**`, `vscode-extension/src/`.
- [client-platform.md](client-platform.md): mobile software keyboard and viewport height, the terminal's extra keys and its own dark/light theme, completion sound. Files: `hooks/useViewportHeight.ts`, `hooks/useAudio.ts`, `components/TerminalExtraKeys.tsx`, `lib/terminal-extra-keys.ts`, `lib/terminal-theme.ts`, `hooks/useTerminalTheme.ts`, the keyboard-open CSS.

---

## File Map

```
app/api/
  sessions/route.ts                GET list all sessions
  sessions/[id]/route.ts           GET/PATCH/DELETE a session
  sessions/[id]/context/route.ts   GET ?leafId=&tail=&before= a page of a leaf's context (tail defaults to 50; before pages upward)
  sessions/[id]/export/route.ts    GET exported HTML
  sessions/[id]/fork/route.ts      POST copy the session's current branch into a new session (never starts an AgentSession)
  sessions/delete/route.ts         POST { ids } delete sessions and their subagents (a project's Delete all sessions); running ones kept
  sessions/stats/route.ts          POST { ids } each session's tokens, cost, tool calls, active time (the agent switcher's rows)
  sessions/[id]/state/route.ts     GET live wrapper state while running
  sessions/ui-state/route.ts       GET/POST sidebar pins, archive, project order and names (set, restore, pin-project, add-projects, move-project, rename-project)
  sessions/[id]/auto-name/route.ts POST generate a session title
  sessions/[id]/revert-turn/route.ts POST delete one turn's entries (busy-refusing, atomic write; embed only)
  embed/route.ts                 GET embed handshake (protocol level + capabilities); heartbeat/, shutdown/ routes
  sessions/search/route.ts         GET session search
  agent/new/route.ts               POST { cwd, type: prompt|ensure_session (start only), message?, toolNames?, provider?, modelId?, thinkingLevel? }
  agent/[id]/route.ts              GET state | POST any command
  agent/[id]/events/route.ts       GET SSE stream
  agent/running/route.ts           GET running + awaiting-input session ids, sidebar pins/archive revision
  auth/api-key/[provider]/route.ts POST/DELETE stored provider API key
  auth/login/[provider]/route.ts   GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts  POST OAuth logout
  auth/providers/route.ts          GET OAuth and API-key provider lists
  cwd/validate/route.ts            POST validate/select a cwd
  cwd/browse/route.ts              GET browse any readable directory for the cwd picker | POST create child directory
  default-cwd/route.ts             POST create ~/pi-cwd/YYYYMMDD (local date)
  home/route.ts                    GET user home directory
  open-in-explorer/route.ts        GET availability | POST open a cwd in the OS file manager (loopback only)
  files/[...path]/route.ts         GET ?type=list|read|download|meta|preview|watch | POST ?type=upload|upload-check|allow-link
  file-index/route.ts              GET file list for @-mentions
  git/status/route.ts              GET changed files for a cwd
  git/diff/route.ts                GET diff of one changed file
  worktrees/route.ts               GET/POST/DELETE git worktrees
  terminal/route.ts                POST create a terminal session
  terminal/[id]/route.ts           GET { id, cwd } (404 once closed; stream at [id]/events) | POST input/resize | DELETE kill
  mcp/route.ts                     GET [?cwd=] Settings › MCP overview, files only | POST add/enable/disable/remove/undo/set-enabled/set-exposure/set-in-project/sign-out
  mcp/test/route.ts                POST { scope, name, cwd? } test one server once (entry read from its file)
  mcp/sign-in/route.ts             POST { scope, name, cwd? } start or join an OAuth sign-in
  mcp/sign-in/[flowId]/route.ts    GET flow state (polled) | POST { redirectUrl } | DELETE cancel
  project-trust/route.ts           GET trust status + project .pi/mcp.json servers (files only) | POST trust, rebuild the cwd's wrappers
  tools/settings/route.ts          GET/PUT defaultTools switches: PowerShell (Windows), Code mode automatic/always; codemode.mode, codemode.inlineBudget
  cache-miss-notices/route.ts      GET/PUT pi's global showCacheMissNotices (Settings › General)
  models/route.ts                  GET ?cwd= { models, modelList, defaultModel, … }
  models/enabled/route.ts          GET/PUT enabledModels switches
  models/default/route.ts          PUT default model / reasoning level for new sessions
  models/refresh/route.ts          POST fetch provider catalogs from pi.dev on demand
  models-config/route.ts           GET/PUT ~/.pi/agent/models.json
  models-config/catalog/route.ts   GET models.dev pricing presets
  models-config/discover/route.ts  POST fetch a configured provider's upstream model list
  models-config/test/route.ts      POST test a configured model/provider
  plugins/route.ts                 GET/POST package plugin management
  plugins/check/route.ts           POST check plugin package updates
  skills/route.ts                  GET/PATCH loaded skills, disable-model-invocation
  skills/content/route.ts          GET one loaded skill's bounded Markdown source, or ?document= a Markdown file in its folder
  skills/install/route.ts          POST install skills via npx skills add
  skills/search/route.ts           POST skills.sh search
  subagents/settings/route.ts      GET/PUT built-in subagent switch and maxConcurrent
  web-auth/route.ts                GET status | POST login | DELETE logout (browser password)
  provider-usage/query/route.ts    POST provider usage quotas
  push/config/route.ts             GET VAPID public key
  push/subscribe/route.ts          POST register a push subscription
  app-update/route.ts              GET current vs latest published pi-web version

lib/
  agent-client.ts           typed fetch helper for /api/agent commands
  rpc-manager.ts            AgentSessionWrapper, registry, startRpcSession
  session-reader.ts         SessionManager wrappers, path cache, buildSessionContext adapter
  session-fork.ts           forkSessionBranch(): the sidebar's Fork, a leaf-branch copy on a fresh SessionManager named after its source, typed refusals
  session-fork-name.ts      client-safe Fork naming: source title + " · " + 4 hex; splitting the suffix off for the row and toast
  file-changes.ts           extract a turn's FileChange[] from messages (edit/write/bash classification, same-path edit aggregation)
  brand.ts                  app display name: Pi Web+ standalone vs Pi for IDE embed (per-host map)
  embed/bridge.ts           page↔host protocol (request/response types + sendEmbedRequest helpers)
  embed/lifecycle.ts        server-side lifecycle sovereignty: watchdog, heartbeat/activity presence, sleep forgiveness
  embed/turn-snapshot.ts    turnId↔entryId pairing (sessionStorage-persisted across reloads)
  embed/messages.ts         embed-mode i18n strings merged into the registry (kept out of upstream message files)
  embed/active-files.ts     host's active-file hint injection
  session-delete.ts         deleteSessions(): session files with their subagents, re-parenting what stays, wrapper shutdown, pins/archive cleanup
  session-tree.ts           sidebar row model: pinned section, project groups and their order, archived predicate, virtual rows, drop targets
  session-ui-state.ts       pi-web-session-state.json (pins, archive, project order and names): lock, atomic write, revision, corrupt backup
  session-ui-state-shared.ts client-safe types and rules of that state: request parsing, apply, undo snapshot
  sidebar-prefs.ts          per-browser sidebar tab, group expand choices, archive folds, pinned-section collapse, files-section fold, folders found outside git
  sidebar-actions.ts        session row menu entries, a project group's name entries and rename request, fork refusal messages, delete-all requests
  session-links.ts          same-instance links: a session's (?session=<id>), a fresh composer's (?cwd=<dir>); the plain-click rule the sidebar keeps in the page
  new-session-context.ts    client-safe: what the project/worktree pickers show (project, worktrees, project list), lag-safe contextForCwd, the directory a group's + and Open in new tab use
  normalize.ts              normalizeToolCalls(): file-format vs our toolCall field names
  message-keys.ts           client-safe React keys of chat messages: a run's messages keep theirs when the file is read again
  types.ts                  shared TypeScript types
  pi-types.ts               local structural types for pi SDK objects
  pi-sdk-internals.ts       loader for SDK modules the package does not export (MCP connection, config, OAuth)
  tool-presets.ts           PRESET_NONE/READ_ONLY/DEFAULT/FULL + getPresetFromTools()
  tool-preset-preference.ts browser-persisted default preset for fresh sessions
  builtin-extensions.ts     codemode / tool-search / mcp built-ins, sandbox self-test, -builtin: switches
  codemode-settings.ts      Code mode automatic/always (+codemode in global defaultTools), codemode.mode and inlineBudget; project overrides
  codemode-view.ts          display helpers for codemode cards
  global-settings-file.ts   locked read-modify-write of global settings.json (SettingsManager's lock)
  regular-file.ts           readRegularFileText(): non-blocking read of a regular file only, optional size cap
  default-preferences.ts    write defaultModel/defaultThinkingLevel; detect project shadowing
  deferred-provider-models.ts models of providers an extension registers only at session_start, re-added to listings
  enabled-models.ts         pure minimal-edit engine for the enabledModels pattern list
  enabled-models-runtime.ts SDK adapter for enabledModels: pattern resolution, provider kinds, settings IO
  model-context.ts          client-safe: managed models' contextWindow overrides in the models.json draft, the Save check
  subagent-settings.ts      read/write ~/.pi/agent/agents/settings.json
  file-access.ts            allowed file roots for /api/files and worktrees
  file-upload-client.ts     browser upload to /api/files ?type=upload, shared by the explorer and chat drops
  linked-directory.ts       directory links leading outside the allowed roots + the allow-link check
  file-paths.ts             client/server path encoding helpers
  delimited-table.ts        client-safe CSV/TSV parsing (RFC 4180, delimiter detection, file line per record) and table layout
  file-tree-visibility.ts   which entries the file tree lists (git check-ignore, name-list fallback)
  file-tree-expansion.ts    the file tree's open directories per cwd: page-memory LRU of 20 folders
  display-path.ts           display-only ~ / ./ path shortening for settings panels
  default-cwd.ts            dated ~/pi-cwd/YYYYMMDD path for "Use default directory"
  worktree.ts               project/worktree resolution and git worktree operations
  draft-store.ts            local draft persistence
  extension-ui-queue.ts     FIFO queues for extension dialogs and custom panels, by request id; isBlockingExtensionUiRequest() (which method a run waits on)
  session-stats-format.ts   client-safe compact counts, costs and active durations of the stats toolbar and agent switcher
  turn-duration.ts          getTurnDurationMs() / formatTurnDuration(): a finished turn's length from its anchor to its last response's end, on pi's timestamps
  transcript-notices.ts     client-safe: showCacheMissNotices notices on chat messages, TUI number formats, a fold's cache-miss sum
  transcript-notices-server.ts the notices derived from session entries (cache-stats port), live ones for message_end, the setting
  markdown.ts               shared markdown helpers
  markdown-blocks.ts        splitMarkdownBlocks(): where a streaming reply may be cut into blocks parsed apart
  highlight-queue.ts        code fences past a task's highlight budget get their colors in idle slices
  prism-languages.ts        loadPrismLanguages(): every Prism language in a chunk of its own, loaded when a highlighter first needs it
  gfm-autolink-email-loader.cjs  bundler loader: remark-gfm's email regex without a lookbehind literal
  node-cli.ts               locate bundled npm-cli.js / npx-cli.js to spawn npm/npx without a shell (Windows)
  npx.ts                    npx runner for skill install
  plugin-updates.ts         npm view update checks for /api/plugins/check
  jsonc.ts                  JSON with comments and trailing commas (models.json is read through it)
  shell-words.ts            split a pasted command line into words without a shell; refuses | && ; redirects $(…)
  key-serializer.ts         serializeByKey(): one globalThis promise chain per key
  stacked-dialog.ts         Escape and focus handling for Settings and dialogs stacked above it
  project-trust.ts          project trust status and decisions; fresh-folder trust-and-write
  mcp-host.ts               per-session MCP host: registers mcp.json servers before prompts, reports status
  mcp-transport.ts          MCP transport factory; stdio gets a sanitized env, never PI_WEB_PASSWORD
  mcp-command.ts            client-safe: who owns /mcp (built-in or another extension)
  mcp-read-only-policy.ts   read-only sessions block MCP tools without readOnlyHint (nested calls too)
  mcp-config-key.ts         canonicalJson() and mcpConfigKey(), the per-process HMAC statuses are keyed by
  mcp-config-values.ts      client-safe: the values pi resolves and the PI_WEB_PASSWORD rule
  mcp-config-read.ts        Settings › MCP reads of both mcp.json files; nothing resolved or run
  mcp-config-file.ts        the mcp.json writer: SDK editor's bytes, lock, atomic write, typed refusals
  mcp-override.ts           project overrides of global servers: the SDK's isOverride() and loader refusals
  mcp-json-error.ts         JSON.parse error messages that never quote the source
  mcp-undo.ts               removed mcp.json entries kept 60 s for undo; only a token reaches the browser
  mcp-status.ts             last known connection state per mcp.json entry (tests and sessions)
  mcp-test.ts               Settings › MCP Test: one bounded, masked SDK connection (sign-in reuses its steps)
  mcp-entry-request.ts      route checks before connecting one mcp.json entry (Test, sign-in); guards /api/mcp and /api/project-trust share
  mcp-sign-in.ts            Settings › MCP OAuth sign-in flows (as pi mcp login), polled by id
  mcp-sign-out.ts           OAuth store keys (name + URL); guard barring token writes by runs started before a sign-out
  mcp-secrets.ts            pure secret classification and masking for MCP config values
  mcp-add.ts                POST /api/mcp add's checks before it writes
  mcp-import.ts             pure paste importer (+ mcp-import-core/json/cli/links.ts)
  mcp-server-display.ts     client-safe display helpers for McpServerInfo (hidden-character escapes, labels)
  mcp-tool-display.ts       server/tool label of an mcp__ call from its result details, never the name

vscode-extension/src/
  piIdeServer.ts          PiIdeServer class: orchestration only (start/stop/release, heartbeat, spawn, attach, embed handshake)
  port-scan.ts            303x listener scan (netstat/lsof/ss→PID→cmdline), occupier report, findFreePort, _npx orphan sweep
  occupier.ts             pure: classifyOccupier + DEFAULT_PACKAGE
  server-resolve.ts       resolve chain legs (executablePath/bundled/global/shim/managed) + install/checkUpdate + SpawnTarget
  diagnostics.ts          startup-failure report (env, resolve legs, port occupants, npm log tail)
  server-status.ts        shared output channel + lifecycle timeline log + stage-status broadcast bus
  managedRuntime.ts       versioned managed runtime (version dirs, marker, install lock, registry compat)
  version.ts              pure: level/semver/spec validation/registry base
  paths.ts                pure: cross-platform path normalization for the bridge (win32/POSIX/UNC/relative)
  revert.ts               pure: applyEditsReversed — occurrence-checked, $-pattern-safe undo of pi edits
  bridge.ts               host-side embed request handlers (files/diff/revert/snapshot/terminal); path allowlist
  extension.ts            activation, commands, status bar, update checks
  webviewProvider.ts      single-document webview shell (postMessage-driven states; CSP + static resources/shell.js)

components/
  AppShell.tsx             layout, URL state, tab management
  SessionSidebar.tsx       toolbar row (Sessions | Files tabs, or the Pi Web brand with the files below them; new, search): tree, archive, menus, toast; files section (resizable, foldable; one header row with the file keys and changed-files count, the picker's row) or tab (picker boxes + file buttons), FileExplorer
  PiWebTitle.tsx           the sidebar's "Pi Web" brand (files below the sessions only): a click scrambles it into the versions
  SessionTree.tsx          virtualized rows of the session tree and the archive view
  SidebarMenu.tsx          sidebar popup menu (bottom sheet on phones), portaled to body: filter field, item secondary actions, the files tab's classic look
  ProjectWorktreePicker.tsx project and worktree boxes + menus: the files' (one row below the sessions, stacked in the tab) and the new-session bar's
  NewSessionContextBar.tsx the picker in its own row under the brand, right above the empty new-session composer; moves go through the sidebar
  WorktreeCreateForm.tsx   "New worktree…" form, a SidebarMenu body
  SidebarToast.tsx         sidebar one-line toast: archive Undo/View, failed saves
  embed/                   embed-mode UI: FileReviewCard/TurnFileReview (per-turn file review), TurnRevertButton + useTurnRevert (turn revert), ActiveFileHint/useActiveFile, IdeHintBadge (standalone-mode IDE hint), useEmbed* hooks
  SidebarIcons.tsx         sidebar stroke icons
  ChatWindow.tsx           chat composition + completion sound
  ChatInput.tsx            input bar + model/thinking/tools/compact controls
  MessageView.tsx          one message (user/assistant/toolCall/toolResult)
  CodemodeToolView.tsx     codemode card: the tool calls its script made
  BranchNavigator.tsx      in-session branch switcher
  ChatMinimap.tsx          scroll minimap beside the message list
  MarkdownBody.tsx         markdown renderer
  ModelsConfig.tsx         Settings › Models: models.json editor
  EnabledModelsSection.tsx model switches inside ModelsConfig (enabledModels)
  ModelContextWindow.tsx   a managed model row's context-window field (blank: no override)
  OAuthPastePanel.tsx      paste box for a sign-in's redirected address or code (Models, MCP)
  ProjectTrustDialog.tsx   trust confirmation listing the project's MCP servers
  AgentsConfig.tsx         built-in subagent toggle + agent profile editor
  SubagentViewer.tsx       read-only right-panel tab of a subagent's transcript (polls the context route)
  PluginsConfig.tsx        Settings › Plugins: installed package plugins
  SkillsConfig.tsx         Settings › Skills: loaded, search, install
  McpConfig.tsx            Settings › MCP: servers, switches, exposure, remove/undo, Test, sign-in, Code mode, trust
  mcp-config-helpers.ts    pure helpers and requests for McpConfig
  McpSignIn.tsx            a server's Sign-in row in Settings › MCP
  mcp-sign-in-helpers.ts   pure helpers and requests for McpSignIn
  McpAddServer.tsx         Settings › MCP add pane: paste, preview, values, name, scope
  mcp-add-helpers.ts       pure helpers and the add request for McpAddServer
  FileExplorer.tsx         file tree in the sidebar
  FileIcons.tsx            file icon helpers
  FileViewer.tsx           file content in a tab
  DelimitedTable.tsx       a CSV/TSV file's Preview: virtualized table, gutter of file lines
  TabBar.tsx               file panel tab bar (file, terminal and subagent tabs)
  TranscriptNotices.tsx    a message's cache and cost notice lines, the fold header's cache-miss text

hooks/
  useAgentSession.ts       messages, streaming, SSE, fork/navigate, reconciliation; built-in slash commands (/session, bare /mcp)
  useStreamingSelector.ts  one value of the streaming store (lib/streaming-message.ts): a chunk re-renders only its subscribers
  useAudio.ts              completion sound + AudioContext unlock
  useDragDrop.ts           chat drop zone: dropped files, folders marked
  useFilesPlacement.ts     per-browser choice: the desktop sidebar's file browser below the sessions or in its own tab
  useGroupDrag.ts          dragging a sidebar project group: mouse threshold, touch/pen long-press, auto-scroll, drop
  useIsMobile.ts           responsive breakpoint
  useSessionUiState.ts     sidebar pins, archive, project order: optimistic writes in order, refetch on revision change
  useSidebarMotion.ts      the sidebar's fold and archive-view motion: phase, end fallback, reduced motion, what shows meanwhile
  useKeyboardShortcuts.ts  Esc stops the running agent unless a field or nearer handler took it; Ctrl+Alt+N
  useResizablePanel.ts     drag/keyboard panel size kept per key; persistClamp: false never saves a short window's clamp
  usePrismLanguages.ts     true once the Prism languages are loaded; starts the load for a highlighter
  useTheme.ts              theme state
  useTerminalTheme.ts      the terminal's own dark/light choice (localStorage), apart from the app theme
```

