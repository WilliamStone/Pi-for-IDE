// Two-process coordination test driver — spawned as a real child process by
// two-process-coordination.test.mjs. Exercises the REAL file-based protocol
// (server-lock + instance-coordination) across OS processes: real mkdir
// locks, real fs.watch, real marker files.
//
//   node --experimental-strip-types src/coordination-driver.mjs <cmd> <runDir> [args]
//
// Commands:
//   lock-race <name>          acquire the server lock, append ENTER/EXIT to race.log
//   sweep-race <name>         same, but against a pre-planted stale lock
//   watch <name> <boot> [child|attached]   watch markers + run invalidateIfBootMismatch
import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.(mjs|cjs|js|ts|json)$/.test(specifier)
    ) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

const [cmd, runDir, ...rest] = process.argv.slice(2);
if (!cmd || !runDir) {
  console.error("usage: coordination-driver <cmd> <runDir> [args]");
  process.exit(2);
}
fs.mkdirSync(runDir, { recursive: true });

if (cmd === "lock-race" || cmd === "sweep-race") {
  const { withServerLock } = await import("./server-lock.ts");
  const name = rest[0];
  const log = path.join(runDir, "race.log");
  await withServerLock(
    "race",
    async () => {
      fs.appendFileSync(log, `ENTER ${name}\n`);
      // Hold the critical section long enough that an unlocked competitor
      // would interleave — if the log stays paired, the lock held.
      await new Promise((r) => setTimeout(r, 350));
      fs.appendFileSync(log, `EXIT ${name}\n`);
    },
    { dir: runDir },
  );
  console.log(`${name} DONE`);
  process.exit(0);
}

if (cmd === "watch") {
  const { watchInstanceMarker, invalidateIfBootMismatch } = await import("./instance-coordination.ts");
  const [name, myBoot, mode] = rest;
  // Fake the held server: attached (no child) unless mode=child.
  globalThis.__piIdeServer = {
    disposed: false,
    embedBoot: myBoot,
    child: mode === "child" ? { pid: 1 } : undefined,
    async stop() {
      console.log(`[${name}] ACTION stop`);
      this.disposed = true;
    },
    release() {
      console.log(`[${name}] ACTION release`);
      this.disposed = true;
    },
  };
  const watcher = watchInstanceMarker(runDir, (boot) => {
    void (async () => {
      const inv = await invalidateIfBootMismatch(boot);
      console.log(`[${name}] marker=${boot} invalidate=${inv}`);
    })();
  });
  if (!watcher) {
    console.log(`[${name}] WATCH_FAILED`);
    process.exit(1);
  }
  console.log(`[${name}] READY`);
  setInterval(() => {}, 60_000); // stay alive until the parent kills us
} else {
  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}
