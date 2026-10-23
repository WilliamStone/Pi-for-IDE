/**
 * 跨窗口实例协调协议——实例标记 + 启动窗口记录 + 失效判定。
 *
 * 协议全貌（参与方：各窗口的扩展宿主、pi-web 服务器进程）：
 *   1. spawn 成功起实例后写 <runtime>/server-instance.json 标记
 *      {boot, origin, at}——boot 是进程启动时刻（Date.now()）。
 *   2. 其他宿主 watch 标记：boot 单调比较，仅"更新"才使本地引用失效；
 *      处置分所有权——自 spawn 的停掉（被取代清理），attach 来的只丢
 *      引用（stop() 对共享服务器会 POST /api/embed/shutdown=误杀）。
 *   3. spawn→bind 之间的盲窗由 ide-spawn-<pid>.json 记录补：兄弟窗口
 *      扫端口全空时见到记录就 attach-等，而不是重复 spawn。
 *
 * 本模块无 vscode 依赖（同 server-lock.ts 风格：channel 注入）——
 * 进程级测试驱动可直接加载它跑真实文件协议。
 */
import * as fs from "fs";
import * as path from "path";
import { ideRunDir } from "./server-lock";

export interface CoordChannel {
  appendLine(message: string): void;
}

const MARKER_NAME = "server-instance.json";
const BOOT_PREFIX = "ide-spawn-";
/** 启动记录有效年龄——冷启 JIT 的就绪可达几十秒；过期即视为崩溃残留。 */
const BOOT_RECORD_MAX_AGE_MS = 90_000;

export interface InstanceMarker {
  boot?: string;
  origin?: string;
  at?: number;
}

export function instanceMarkerPath(dir: string): string {
  return path.join(dir, MARKER_NAME);
}

export function readInstanceMarker(dir: string): InstanceMarker | undefined {
  try {
    return JSON.parse(fs.readFileSync(instanceMarkerPath(dir), "utf8")) as InstanceMarker;
  } catch {
    return undefined; // 文件半截/已删——等下一次事件
  }
}

/** 只在 boot 变化时写——重复写会触发无谓的 watch 事件风暴。 */
export function writeInstanceMarker(dir: string, marker: InstanceMarker, channel?: CoordChannel): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const prev = readInstanceMarker(dir)?.boot;
    if (prev === marker.boot) return;
    fs.writeFileSync(
      instanceMarkerPath(dir),
      JSON.stringify({ ...marker, at: marker.at ?? Date.now() }, null, 2),
    );
    channel?.appendLine(`instance marker written: boot=${marker.boot ?? "unknown"} @ ${marker.origin}`);
  } catch (e) {
    channel?.appendLine(`instance marker write failed (non-fatal): ${e}`);
  }
}

/**
 * watch 标记文件，boot 变化时回调（300ms 去抖吸收写风暴）。
 * 事件驱动、不轮询；目录不可 watch 时返回 undefined——降级为非功能
 * 损失（标记语义是优化层），调用方照常运行。
 */
export function watchInstanceMarker(
  dir: string,
  onBoot: (boot: string | undefined) => void,
  channel?: CoordChannel,
  debounceMs = 300,
): { dispose(): void } | undefined {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // 目录建不了交给 watch/read 的失败路径——不阻塞。
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const watcher = fs.watch(dir, (_ev, name) => {
      if (name !== MARKER_NAME) return;
      clearTimeout(timer);
      timer = setTimeout(() => onBoot(readInstanceMarker(dir)?.boot), debounceMs);
    });
    return {
      dispose: () => {
        clearTimeout(timer);
        watcher.close();
      },
    };
  } catch (e) {
    channel?.appendLine(`instance marker watch failed (non-fatal): ${e}`);
    return undefined;
  }
}

// ---- 启动窗口记录 ---------------------------------------------------------

/**
 * spawn 在 bind 前写 `ide-spawn-<pid>.json`（pid/port/url/startedAt）。
 * 返回删除函数——就绪/退出/超时路径都应调用；残留由读端按
 * "进程存活 + <90s"过滤兜底。
 */
export function recordSpawnBoot(pid: number | undefined, port: number): () => void {
  const file = path.join(ideRunDir(), `${BOOT_PREFIX}${pid ?? "unknown"}.json`);
  const drop = () => {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // 尽力而为——读端有年龄/存活双重过滤。
    }
  };
  if (pid === undefined) return drop;
  try {
    fs.mkdirSync(ideRunDir(), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ pid, port, url: `http://127.0.0.1:${port}`, startedAt: new Date().toISOString() }),
    );
  } catch {
    // 记录写失败不阻塞 spawn——只是这层协同失效。
  }
  return drop;
}

/** 所有存活且未过期的启动记录——调用方把 port 当 attach 候选对待。 */
export function listSpawnBootRecords(): Array<{ pid: number; port: number }> {
  const dir = ideRunDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const records: Array<{ pid: number; port: number }> = [];
  for (const name of names) {
    if (!name.startsWith(BOOT_PREFIX) || !name.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as {
        pid?: number;
        port?: number;
        startedAt?: string;
      };
      const age = Date.now() - Date.parse(rec.startedAt ?? "");
      if (!rec.pid || !rec.port || !(age >= 0 && age < BOOT_RECORD_MAX_AGE_MS)) continue;
      try {
        process.kill(rec.pid, 0); // 存活检查——PID 复用由年龄上限兜底
      } catch {
        continue;
      }
      records.push({ pid: rec.pid, port: rec.port });
    } catch {
      // 读不了的记录当不存在——下轮再扫。
    }
  }
  return records;
}

// ---- 失效判定 -------------------------------------------------------------

/** 判定函数需要的服务器实例最小面——让模块不依赖 PiIdeServer/vscode。 */
export interface HeldServer {
  disposed: boolean;
  embedBoot?: string;
  child?: unknown;
  stop(): Promise<void>;
  release(): void;
}

/**
 * 共享标记声明了更新的实例 → 本地服务器已过期（别窗升级/重启换包）。
 *
 * 判据单调：boot = Date.now() 时间戳，仅 marker.boot > 本地 boot 才失效
 * ——否则竞态下晚写出的旧 spawn 标记会倒踢正在运行的新实例，双窗互写
 * 即死循环。处置分所有权：自 spawn 的旧实例停掉（被取代的清理）；
 * attach 来的共享服务器只丢引用——stop() 对无 child 实例会 POST
 * /api/embed/shutdown，误杀别窗正在使用的实例。
 *
 * 返回 true = 已失效（调用方应重挂到新实例恢复树/状态）。
 */
export async function invalidateIfBootMismatch(
  boot: string | undefined,
  opts: {
    /** 默认读全局单例（扩展宿主的真实服务器）；测试可注入假实例。 */
    existing?: HeldServer;
    log?: (msg: string) => void;
  } = {},
): Promise<boolean> {
  const existing =
    opts.existing ?? (globalThis as Record<string, unknown>).__piIdeServer as HeldServer | undefined;
  const log = opts.log ?? (() => {});
  if (!existing || existing.disposed) return false;
  if (!boot || existing.embedBoot === boot) return false; // 已是当前实例
  if (!(Number(boot) > Number(existing.embedBoot ?? "0"))) return false; // 只认更新
  log(
    `invalidateIfBootMismatch: local boot=${existing.embedBoot ?? "unknown"} vs newer marker boot=${boot} — ${existing.child ? "stopping stale spawned server" : "releasing shared-server reference"}`,
  );
  if (existing.child) await existing.stop();
  else existing.release();
  return true;
}
