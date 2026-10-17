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

## Authoritative test env: docker155 (Linux)

The Windows dev box passes too, but its suite has platform skips and slow subagent tests. The **authoritative** gate is the LAN docker host — upstream's environment exactly, ~3.3min for the full suite:

- Host: `ssh docker155` (root@192.168.1.155, key `~/.ssh/lan_rsa`, recorded in `machine-env.md`). DockerHub unreachable; node is a bind-mounted binary at `/root/node24` and git at host paths — do NOT `apt`.
- Repo: `git archive HEAD | ssh docker155 'tar xz -C /root/pi-code'` (tracked files only; commit test changes first).
- Install once per source update: `docker run --rm -v /root/node24:/opt/node:ro -v /root/pi-code:/w -w /w ubuntu:22.04 bash -c 'PATH=/opt/node/bin:$PATH npm ci --registry=https://registry.npmmirror.com --replace-registry-host=always --no-audit --no-fund'`
- Test run must be **non-root** (root ignores read-only dirs → false failures) and mount host git:

```bash
docker run --rm --user 1000:1000 -e HOME=/tmp \
  -e GIT_AUTHOR_NAME=t -e GIT_AUTHOR_EMAIL=t@t -e GIT_COMMITTER_NAME=t -e GIT_COMMITTER_EMAIL=t@t \
  -v /root/node24:/opt/node:ro -v /root/pi-code:/w \
  -v /usr/bin/git:/usr/bin/git:ro -v /usr/lib/git-core:/usr/lib/git-core:ro \
  -v /usr/share/git-core:/usr/share/git-core:ro \
  -v /lib/x86_64-linux-gnu/libpcre2-8.so.0:/lib/x86_64-linux-gnu/libpcre2-8.so.0:ro \
  -v /lib/x86_64-linux-gnu/libz.so.1:/lib/x86_64-linux-gnu/libz.so.1:ro \
  -w /w ubuntu:22.04 bash -c 'PATH=/opt/node/bin:$PATH npm test'
```

v0.12.2 result: **2779 tests, 2778 pass, 0 fail, 1 skip** in 196s. The Windows-only skips (read-only-dir, mode bits) DO run here.

## Test suite practicalities

- Full run ~10–25min on Windows; prefer targeted runs while iterating:
  `node --experimental-strip-types --test [--test-name-pattern="…"] <file>`
- Before running the suite after a merge, pre-scan the upstream test diff for the patterns above — most failures are findable by grep, not by running.
