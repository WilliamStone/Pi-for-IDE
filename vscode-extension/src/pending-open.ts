/**
 * 跨窗"打开会话"交接：源窗写 pending 记录 → openFolder(forceReuseWindow)
 * （已开同目录窗口则聚焦、否则新开）→ 目标窗消费记录自动打开该会话。
 *
 * 文件即消息，与 ide-server.lock 同址——pi-web-run/ 本来就是全窗口共享
 * 目录。对两种目标同一条通道：新窗口 activate 时首轮扫描命中；已开窗口
 * 由 fs.watch 即写即应。无 vscode 依赖，node:test 可测。
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { ideRunDir } from "./server-lock";
import { sameDir } from "./paths";

const DIR_NAME = "pending-opens";
const TTL_MS = 5 * 60_000;

export interface PendingOpen {
  sessionId: string;
  /** openFolder 的目标目录——即目标窗的工作区根。 */
  dir: string;
  at: number;
}

export function pendingOpensDir(runDir = ideRunDir()): string {
  return path.join(runDir, DIR_NAME);
}

/** 发起侧：开窗前写记录。失败无碍——窗口照样开，只是少了自动开页。 */
export function writePendingOpen(dir: string, sessionId: string, runDir = ideRunDir()): void {
  try {
    const d = pendingOpensDir(runDir);
    fs.mkdirSync(d, { recursive: true });
    const rec: PendingOpen = { sessionId, dir, at: Date.now() };
    fs.writeFileSync(path.join(d, `${crypto.randomUUID()}.json`), JSON.stringify(rec));
  } catch {
    // 记录写不进去不挡窗口打开。
  }
}

export interface PendingOpenWatchDeps {
  workspaceRoots: () => string[];
  consume: (sessionId: string) => void;
  log?: (line: string) => void;
  runDir?: string;
  now?: () => number;
}

/** 一轮目录处理：命中本工作区根的消费删除、过期记录清扫。 */
function scanPendingOpens(d: string, deps: PendingOpenWatchDeps): void {
  let names: string[];
  try {
    names = fs.readdirSync(d);
  } catch {
    return;
  }
  const now = (deps.now ?? Date.now)();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(d, name);
    let rec: PendingOpen;
    try {
      rec = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue; // 对端还在写——下轮再读。
    }
    const expired = now - (rec.at || 0) > TTL_MS;
    const hit = !expired && !!rec.dir && deps.workspaceRoots().some((r) => sameDir(r, rec.dir));
    if (!hit && !expired) continue;
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // 删不掉留给下次清扫兜底。
    }
    if (hit && rec.sessionId) {
      deps.log?.(`pending open consumed: ${rec.dir} → session ${rec.sessionId}`);
      deps.consume(rec.sessionId);
    }
  }
}

/** 常驻消费端：调用时先扫一轮（新窗激活场景），再 fs.watch 常驻监听。 */
export function watchPendingOpens(deps: PendingOpenWatchDeps): { dispose(): void } | undefined {
  const d = pendingOpensDir(deps.runDir);
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch {
    return undefined;
  }
  scanPendingOpens(d, deps);
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(d, () => scanPendingOpens(d, deps));
  } catch {
    return undefined;
  }
  return { dispose: () => watcher.close() };
}
