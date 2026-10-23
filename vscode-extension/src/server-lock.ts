/**
 * 跨窗口/跨编辑器的 pi-web 协同锁——"同时只有一个操作者做启动/安装/
 * 检查版本"的临界区互斥。文件锁选它因为它是最便宜的正确原语：
 * mkdir 在 Windows/POSIX 上都是原子抢占，无需额外依赖。
 *
 * 锁目录与 pi-web 自身的 run-records 同址（bin/run-records.js 的
 * getRunDir 口径：$PI_CODING_AGENT_DIR/pi-web-run，默认 ~/.pi/agent/
 * pi-web-run）——同一台机器上所有窗口、所有编辑器安装、standalone
 * 起的服务都共享这个目录，锁天然覆盖全部协同面。
 *
 * 它是"优化"不是"硬保证"：获取超时（默认 120s）或锁目录不可写时
 * 降级为无锁执行（等价于加锁前的行为——下游 attach/幂等安装仍能
 * 收敛），绝不会让服务器启动被一个残留锁永久卡死。陈旧锁按"持有者
 * PID 已死 or 超龄"清扫。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface LockChannel {
  appendLine(message: string): void;
}

export interface ServerLockDeps {
  /** 锁目录（默认 ideRunDir()）。测试注入临时目录。 */
  dir?: string;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  acquireTimeoutMs?: number;
  staleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** 与 bin/run-records.js 的 getAgentDir 同口径——两处必须一致，改一处同步另一处。 */
function agentDir(env: NodeJS.ProcessEnv, home: string): string {
  const configured = env.PI_CODING_AGENT_DIR;
  if (!configured) return path.join(home, ".pi", "agent");
  if (configured === "~") return home;
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return path.join(home, configured.slice(2));
  }
  return configured;
}

/** pi-web 运行状态共享目录（run-records、本锁都在这里）。 */
export function ideRunDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(agentDir(env, os.homedir()), "pi-web-run");
}

const LOCK_DIR_NAME = "ide-server.lock";
const DEFAULT_ACQUIRE_TIMEOUT_MS = 120_000;
const DEFAULT_STALE_MS = 10 * 60_000;
const POLL_MS = 300;

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM：进程在但属于别人——算活着。
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface OwnerInfo {
  pid: number;
  op: string;
  at: number;
}

// ---- 同进程互斥 -------------------------------------------------------
// 扩展宿主是单进程：同一窗口内并发 ensureStarted/install/检查先由进程内
// 串行队列排队；held 标记让临界区内的嵌套调用（如 startProcess → resolve
// → managed 安装）重入而不是死锁。
let inProcess: Promise<unknown> = Promise.resolve();
let held = false;

async function acquireFileLock(
  lockDir: string,
  op: string,
  deps: Required<Pick<ServerLockDeps, "isAlive" | "now" | "acquireTimeoutMs" | "staleMs" | "sleep">>,
  channel?: LockChannel,
): Promise<boolean> {
  const ownerFile = path.join(lockDir, "owner.json");
  const deadline = deps.now() + deps.acquireTimeoutMs;
  let waited = false;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      const owner: OwnerInfo = { pid: process.pid, op, at: deps.now() };
      try {
        fs.writeFileSync(ownerFile, JSON.stringify(owner));
      } catch {
        // owner.json 写失败无碍——清扫端把缺文件的锁按"年轻"对待。
      }
      if (waited) channel?.appendLine(`server lock acquired after wait (${op}).`);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        channel?.appendLine(
          `server lock unavailable (${(e as NodeJS.ErrnoException).code ?? e}) — proceeding without it.`,
        );
        return false;
      }
    }
    // EEXIST：判陈旧。owner.json 缺失/读不了 → 视为刚被占（年轻）→ 等。
    let stale = false;
    try {
      const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as OwnerInfo;
      const age = deps.now() - (owner.at || 0);
      if (owner.pid === process.pid) {
        // 同进程上一个临界区没释放干净（崩在 finally 前）——回收。
        stale = true;
      } else if (age > deps.staleMs || !deps.isAlive(owner.pid)) {
        stale = true;
      }
    } catch {
      // 读不出 owner：可能是对方 mkdir 后还没来得及写——当年轻锁等。
    }
    if (stale) {
      try {
        fs.rmSync(lockDir, { recursive: true, force: true });
        channel?.appendLine(`swept a stale server lock (${op}).`);
      } catch {
        // 抢不过就等下一轮。
      }
      continue;
    }
    if (!waited) {
      channel?.appendLine(`server lock held by another window — waiting (${op})…`);
      waited = true;
    }
    if (deps.now() >= deadline) {
      channel?.appendLine(
        `server lock wait timed out after ${Math.round(deps.acquireTimeoutMs / 1000)}s — proceeding without it (${op}).`,
      );
      return false;
    }
    await deps.sleep(POLL_MS);
  }
}

function releaseFileLock(lockDir: string): void {
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // 残留由下一任的清扫兜底。
  }
}

/**
 * 在跨窗口互斥锁内执行 fn。返回值即 fn 的返回值。锁不可用的极端情况
 * （超时/不可写）下 fn 仍会执行——调用方必须保证临界区内操作自身幂等
 * （attach 成功即不重复 spawn、安装对已就绪槽短路）。
 */
export async function withServerLock<T>(
  op: string,
  fn: () => Promise<T>,
  deps: ServerLockDeps = {},
  channel?: LockChannel,
): Promise<T> {
  if (held) return fn(); // 同进程重入
  const resolved = {
    isAlive: deps.isAlive ?? defaultIsAlive,
    now: deps.now ?? Date.now,
    acquireTimeoutMs: deps.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
    staleMs: deps.staleMs ?? DEFAULT_STALE_MS,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
  };
  const lockDir = path.join(deps.dir ?? ideRunDir(), LOCK_DIR_NAME);
  // 进程内排队
  const prev = inProcess;
  let releaseQueue!: () => void;
  inProcess = prev.then(() => new Promise<void>((r) => (releaseQueue = r)));
  await prev;
  try {
    const acquired = await acquireFileLock(lockDir, op, resolved, channel);
    if (acquired) held = true;
    try {
      return await fn();
    } finally {
      if (acquired) {
        held = false;
        releaseFileLock(lockDir);
      }
    }
  } finally {
    releaseQueue();
  }
}
