# Upstream Sync SOP — pi-web → pi-web-for-ide

Syncs are merge-based (`scripts/sync-upstream.sh <tag>`); never rebase/rewrite upstream history. Read this before starting a sync.

## Product identity — always keep OURS

When conflicts touch these, resolve in favor of the product file, not upstream:

| File | Keep |
|---|---|
| `package.json`, `package-lock.json` | `@william_stone/pi-web-for-ide`, version `<upstream>-<n>`, bin `pi-web-for-ide`, homepage/repo → WilliamStone/Pi-for-IDE, standalone files list, build/prepack hooks |
| `README.md`, `docs/README.*` | product docs; upstream's describe the wrong package/CLI/port — keep our short guides, link upstream for detail |
| `lib/brand.ts`, `app/manifest.ts` | Pi Web+ standalone / Pi for IDE embed naming |
| `lib/embed/**`, `components/embed/**`, `hooks/useEmbed*` | ours entirely — upstream must not remove |
| `bin/pi-web-standalone.js`, `bin/pi-web-update*.js`, `scripts/prepare-standalone.js` | standalone packaging — ours or fork-modified |
| `vscode-extension/**` | ours entirely |
| i18n message files (`lib/i18n/messages/*`, `lib/embed/messages.ts`) | merge upstream keys in, keep our keys |

Version numbering: `0.12.2-1` = upstream base + our iteration. Bump the suffix per release on the same upstream base.

## After resolving conflicts

```bash
npm install --no-audit --no-fund
node_modules/.bin/tsc --noEmit
npm run lint
npm test        # ~10min; required, not optional
```

Then verify: no `<<<<<<<` markers, `git status` clean, package identity intact (name/version/bin).

## Windows test-failure playbook

Upstream tests assume a POSIX dev box. On Windows these fail predictably — pattern-match before diagnosing:

| Symptom | Cause | Fix |
|---|---|---|
| `ERR_UNSUPPORTED_ESM_URL_SCHEME` `'s:'` | `await import(absolutePath)` — Windows paths aren't URLs | `await import(pathToFileURL(p).href)` |
| `~/.agents/skills` fixture contaminated | temp dir inside user profile → ancestor scan finds the developer's real skills | `mkdtemp` under `process.cwd()`, not `tmpdir()` |
| `homedir()` ignores `HOME` | Windows reads `%USERPROFILE%` | set **both** `HOME` and `USERPROFILE` in the test |
| `mode & 0o777 !== 0o600` | NTFS has no POSIX permission bits | skip that assert on `win32` |
| "read-only dir" still writable | dir readonly attribute doesn't block writes on Windows | `{ skip: process.platform === "win32" }` |
| `EBUSY rmdir` in cleanup | spawned MCP/pty children still hold the cwd | `rm(dir, {maxRetries: 30, retryDelay: 500})`; swallow residual EBUSY on win32 — OS reclaims %TEMP% |
| `pty.pid === 0` | conpty doesn't expose a real pid | accept `0` on win32 |
| `!command` fixture does nothing | `touch`/shell builtins are POSIX | use `node -e "fs.writeFileSync('${path}','')"` with forward slashes |
| source-slice tests return empty | working copy CRLF breaks `indexOf(';\n')` / `/\n}\n/` | `.gitattributes` `* eol=lf` prevents; slice by `;` not `;\n`; tolerate `\r?` |
| `${a}${delimiter}${b}` expected `:`/`;` | `path.delimiter` is host-dependent but platform is stubbed | hardcode the stubbed platform's separator |
| `file:///tmp/x` throws | Windows file URLs need a drive letter | `file:///C:/x` on win32 |
| brand asserts `Pi Web` | product is `Pi Web+` standalone / `Pi for IDE` embed | update the assertion, it's intentional |
| extracted-code sandbox `X is not defined` | the test evals a source callback without our fork's imports | add a stub to the `runInNewContext` context |

Locale: `defaultLocale` is `"en"` (SSR default; browser detection still applies post-hydration). Rendering tests assert English — do not revert it.

Known remaining: `lib/subagent-mcp.integration.test.mjs` takes ~233s per mcp test on Windows (SDK-side connect wait, still passes). Suspect antivirus interception of child spawns or proxy env vars — verify by retesting with Defender off / unset `HTTP(S)_PROXY`.

## Test suite practicalities

- Full run ~10–25min on Windows; prefer targeted runs while iterating:
  `node --experimental-strip-types --test [--test-name-pattern="…"] <file>`
- Before running the suite after a merge, pre-scan the upstream test diff for the patterns above — most failures are findable by grep, not by running.
