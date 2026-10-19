# Turn Revert — design notes

Status: **design draft**（探索侧；现行实现见文末"现状"一节，本文档描述的是它的演进方向）

Reverting a turn is really two different things wearing one button:
**transcript surgery** (deleting session-file entries) and **file rollback**
(restoring disk contents). They are separable — each can succeed or fail
alone, and only one combination is ever fully coherent.

## The two operations

| | 「回退到此」 rewind-to-point | 「删除此段」 excise-record |
|---|---|---|
| Transcript | truncate everything after the point | remove the turn's entries, re-link children to its parent |
| Files | restore the point's snapshot state | untouched |
| Coherence | **self-consistent** (pi's model is append-only + truncation) | transcript-only; later turns may reference deleted context |

Rewind is the only operation where transcript and disk agree afterwards:
everything after the point is gone on both sides. Excise is for "this turn was
off-topic, keep the rest" hygiene — a valid user intent where *not* touching
files is the correct behavior.

The current single "revert this turn" button does a surgical excise **plus** a
file rollback — the non-prefix case: later turns' messages and file claims
survive on top of reverted state. Bounded today by the 3-turn snapshot window,
but semantically impure. The direction: present the two as distinct
operations.

## Granularity

A user message can spawn hundreds of tool calls; the agent often derails
mid-turn. "Back to the previous user turn" throws away the good prefix. The
entry tree already supports arbitrary boundaries — revert points can hang on
individual tool calls / assistant entries (each FileReviewCard row is a
natural affordance). This turns "per-turn snapshot" into "per-mutation
snapshot".

## Capture: effect-based, not channel-based

The only capture scheme that covers *all* write channels (pi tools, MCP
servers with arbitrary names, bash redirection, external edits) is watching
the filesystem — a per-session watcher on cwd collecting changed paths,
snapshotted at each tool-result boundary. Tool-declared paths alone can never
be complete.

**Shadow store, not the workspace's git**: `GIT_DIR` under globalStorage,
`GIT_WORK_TREE` = the session cwd — or simpler, a content-addressed file
store. Either way the workspace's own repo, refs, index and .gitignore are
untouched. Ignored files (`.env`, uncommitted source) are exactly what must be
captured; our own ignore list excludes `node_modules`/`.git`/build output.

The watcher only ever yields *paths*; content-level capture happens at read
time — each event triggers a full-content snapshot of the reported paths into
the store. Revert needs point-in-time file *states*, not diffs, so nothing has
to be computed at capture; diffs are derived on display by comparing two
snapshots. Building this on git's object layer (`hash-object`/`write-tree`/
`commit-tree`) is intentionally "another git" — versioning, dedup and tree
diffing come free; only the working-tree/index/refs coupling is skipped.

## Attribution: the honest core problem

Watchers tell you *what* changed, never *who* changed it. Two sessions sharing
a cwd — or nested workspaces (a session on the repo root and one inside a
subdirectory) — cannot be told apart by file events. This is not fixable by
watching harder; it defines the trust model instead:

| Tier | Signal | Revert treatment |
|---|---|---|
| **Declared** | toolCall carries a path (edit/write/apply_patch, `mcp__*.write/edit`) | attributed to that turn — revertible |
| **Sole-observer** | watcher saw a change while exactly one session runs in the tree | probably that session's — revertible |
| **Ambient** | change while ≥2 sessions share the tree, or outside any tool window | recorded, **not** reverted |

Deterministic nested-workspace rule: a path under an *active* inner session's
cwd belongs to the inner session; outer sessions treat it as foreign.

Asymmetry is the feature: capture everything, revert only what is attributed.
The gap between "seen" and "attributable" is where the danger lives, and it
stays listed, never silently undone.

### Worktree-per-session isolation (alternative model)

Giving every session its own git worktree eliminates the attribution problem
outright — a watcher inside each tree sees only that session's writes. The
costs are real: the user stops seeing the agent edit *their* files live
(active-file hints and the "watch it change in my editor" UX depend on the
real workspace); merge-back introduces conflicts and timing questions; and it
presumes a git repo again. And the final problem does not disappear: after the
merge, "which line came from which session" becomes a merge-tracking problem —
ambiguity moves from write-time to merge-time rather than dissolving.

Verdict: a valid **opt-in isolation mode** for multi-agent or risky workloads
(pi already has worktree isolation for subagents), not the default
architecture. The attribution tiers exist precisely because the default
workspace is shared and live.

### Where the pi-plugin shape helps

A pi extension runs inside the agent process and sees *that* session's tool
events — declared-tier attribution is free and exact, no guessing. A plausible
split: a plugin does declared-tier capture; the server-side watcher/store
covers the observed and ambient tiers. Transcript surgery and the UI
(revert entry points, confirm dialog) stay pi-web's — the session file is its
document model regardless of who captures files.

## Boundaries that do not shrink

- **Non-file side effects**: spawned processes, network calls, external state
  — list-only, never rolled back (same line Devin draws).
- **Out-of-cwd writes**: the watcher's root bounds tracking.
- **Concurrent edits to the same file** by two sessions: an incoherent
  scenario before revert even enters the picture; ambient tier keeps us from
  making it worse.

## Prior art: Devin

Same tracking boundary: own-tool writes revertible, third-party/shell writes
listed-only. One thing worth borrowing: on revert Devin asks "roll back or
keep file changes" — i.e. presents our two operations as a user choice. Ours
would be rewind / excise / cancel rather than a single combined action.

## What does not change

- Per-turn snapshot capture at prompt time (already a subset of per-mutation
  capture — the same mechanism at coarser cadence).
- `revert-turn` route invariants: refuse while running, atomic write, never
  delete the header, never delete everything.
- Revert safety rules: occurrence-checked edit reversal, `$`-pattern-safe
  replacement, cwd-subtree allowlist for writes.

## Current implementation (inherited from pi-code, hardened this round)

- `TurnSnapshotTracker` (`lib/embed/turn-snapshot.ts`): per-user-turn before
  snapshots, `MAX_TURNS=3` window, sessionStorage-persisted id pairing.
- `extractFileChanges` (`lib/file-changes.ts`): turn-scoped change list from
  toolCalls — declared tier only.
- `revert-turn` route: deletes the turn's entries, rewires children to the
  turn's parent (mid-fork beheads the branch — the tree still forks; see
  embed-protocol.md "Turn revert semantics"). Entries produced by subagent
  sessions are not removed — their own session files stay behind.
- Extension `bridge.ts`: `revertEdit` (occurrence-checked reverse-apply),
  `revertFiles` (snapshot restore, HEAD fallback, unlink turn-created files),
  `captureSnapshot` (declared-path before-content).

## Open questions

- Snapshot store: shadow-git objects vs plain content-addressed copies
  (decide at implementation time; git buys compression+dedup for free).
- Retention: last N snapshots per session + age GC; store under
  globalStorage, never inside the workspace.
- UI: where entry-level revert affordances live (FileReviewCard rows vs a
  dedicated timeline), and the confirm dialog's wording for each tier.
- Whether excise keeps its current "no file touch" default or offers the
  combined mode behind an explicit second option.
