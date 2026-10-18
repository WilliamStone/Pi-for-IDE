// 303x 端口占用扫描 + 孤儿清扫——从 piIdeServer.ts 拆出。
// 用途：启动时识别"另一个编辑器实例的旧包/上游/孤儿 pi-web 进程"——
// 这类占位会导致新实例换端口、攥住 npx 缓存或让用户连到旧代码。

import * as cp from "child_process";
import * as net from "net";
import * as vscode from "vscode";
import { classifyOccupier, PortOccupier } from "./occupier";
import { logLifecycle } from "./server-status";

const exec = (cmd: string, timeout = 10_000): Promise<string> =>
  new Promise((r) => cp.exec(cmd, { timeout }, (_e, out) => r(out)));

/** 扫描 303x 端口上的监听者，解析 PID→命令行并分类。 */
export async function scanPortOccupiers(
  from = 3030,
  to = 3039,
  pkgName?: string,
): Promise<PortOccupier[]> {
  // 1) 拿 303x 监听者的 port→pid 表。
  const listeners: { port: number; pid: number }[] = [];
  if (process.platform === "win32") {
    const out = await exec('netstat -ano | findstr "LISTENING" | findstr ":303"');
    for (const m of out.matchAll(/:(\d+)\s+[\d.:*]+\s+LISTENING\s+(\d+)/g)) {
      const port = Number(m[1]);
      if (port >= from && port <= to) listeners.push({ port, pid: Number(m[2]) });
    }
  } else if (process.platform === "darwin") {
    // macOS 没有 ss/fuser——lsof 一次拿端口与 pid。
    const out = await exec(`lsof -nP -iTCP:${from}-${to} -sTCP:LISTEN 2>/dev/null`);
    for (const m of out.matchAll(/^(\S+)\s+(\d+)\s+.*:(\d+)\s+\(LISTEN\)$/gm)) {
      listeners.push({ port: Number(m[3]), pid: Number(m[2]) });
    }
  } else {
    const out = await exec(
      `ss -tln 2>/dev/null | grep -oE ':30[0-9]{2} ' | tr -d ' :' | while read p; do
         fuser "$p"/tcp 2>/dev/null | xargs -r -n1 echo "$p"; done`,
    );
    for (const m of out.matchAll(/^(\d+)\s+(\d+)$/gm)) {
      listeners.push({ port: Number(m[1]), pid: Number(m[2]) });
    }
  }
  if (!listeners.length) return [];
  // 2) 批量取这些 pid 的命令行。
  const pids = [...new Set(listeners.map((l) => l.pid))];
  const cmdlines = new Map<number, string>();
  if (process.platform === "win32") {
    const ps = pids.map((p) => `,${p}`).join("");
    const out = await exec(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { @( ${ps.slice(1)} ) -contains $_.ProcessId } | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.CommandLine }"`,
      15_000,
    );
    for (const line of out.split(/\r?\n/)) {
      const i = line.indexOf("|");
      if (i > 0) cmdlines.set(Number(line.slice(0, i).trim()), line.slice(i + 1).trim());
    }
  } else {
    const out = await exec(`ps -o pid= -o command= -p ${pids.join(",")}`);
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (m) cmdlines.set(Number(m[1]), m[2]);
    }
  }
  return listeners.map((l) => {
    const cmdline = cmdlines.get(l.pid) ?? "";
    return { port: l.port, pid: l.pid, cmdline, kind: classifyOccupier(cmdline, pkgName) };
  });
}

/** 启动时顺扫 303x：写生命周期/诊断日志；对可疑占位者（旧包/上游）给提示——
 *  不自动杀：那可能是用户有意运行的独立 pi-web 实例。 */
export async function reportPortOccupiers(
  channel: vscode.OutputChannel,
  pkgName?: string,
): Promise<void> {
  try {
    const occupiers = await scanPortOccupiers(undefined, undefined, pkgName);
    const suspicious = occupiers.filter((o) => o.kind === "unscoped" || o.kind === "upstream");
    for (const o of occupiers) {
      const short = o.cmdline.length > 140 ? "…" + o.cmdline.slice(-140) : o.cmdline;
      channel.appendLine(`port ${o.port} occupied by PID ${o.pid} [${o.kind}] ${short || "(no cmdline)"}`);
      logLifecycle(`port ${o.port} occupied by PID ${o.pid} [${o.kind}]`);
    }
    if (suspicious.length) {
      const list = suspicious.map((o) => `PID ${o.pid} (${o.kind === "unscoped" ? "legacy unscoped package" : "upstream pi-web"}, port ${o.port})`).join(", ");
      void vscode.window.showWarningMessage(
        `Pi for IDE: a likely stale pi-web process is running in another window/editor instance — ${list} (not this window). This instance switched to another port automatically. If it misbehaves, run "Pi for IDE: Stop Server" in that window, or kill it (taskkill /PID <pid> /T /F).`,
      );
    }
  } catch {
    // 扫描失败不阻断启动。
  }
}

export function findFreePort(startPort: number): Promise<number> {
  return new Promise((resolve) => {
    const tryPort = (port: number, attempts = 0): void => {
      if (attempts >= 200) {
        // 兜底：让 OS 分配端口，避免无限探测。
        resolve(0);
        return;
      }
      const tester = net.createServer();
      tester.unref();
      tester.once("error", () => {
        try {
          tester.close();
        } catch {
          // 未监听，忽略。
        }
        tryPort(port + 1, attempts + 1);
      });
      tester.listen(port, "127.0.0.1", () => {
        tester.close(() => resolve(port));
      });
    };
    tryPort(startPort);
  });
}

/** 过渡兜底：杀掉 _npx 缓存里残留的 pi-web 服务进程（下几个版本后移除）。
 * 历史版本 stop 只杀进程顶层，server.js 孤儿会攥住 _npx 缓存目录致后续
 * npx EBUSY——托管路径已不再用该缓存，这里只做存量清理。 */
export async function sweepLegacyOrphans(channel: vscode.OutputChannel): Promise<void> {
  const kill = (pid: number): void => {
    const cmd =
      process.platform === "win32"
        ? `taskkill /PID ${pid} /T /F`
        : `kill -TERM ${pid}`;
    cp.exec(cmd, { timeout: 10_000 }, (e, out) => {
      const merged = `${out}`;
      // 进程已退出/正被另一窗口终止是良性结果，不刷屏。
      if (!e || /cannot be|not found|不存在|不受支持|being terminated/i.test(merged + e.message)) {
        channel.appendLine(`orphan cleanup ${pid}: already exited or terminating${e ? " (benign)" : ""}`);
        return;
      }
      // 兜底：不经树杀，直接强杀该 PID。
      const fallback =
        process.platform === "win32"
          ? `powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force"`
          : `kill -9 ${pid}`;
      cp.exec(fallback, { timeout: 10_000 }, (e2) => {
        channel.appendLine(`orphan cleanup ${pid}: ${e2 ? "failed " + e2.message : "terminated"}`);
      });
    });
  };
  if (process.platform === "win32") {
    // 注意：整条命令被 cmd 包在双引号里执行，内部只能用单引号——嵌双引号
    // 会被 cmd 截断致 PowerShell 静默失败（曾致清扫空跑）。
    const ps =
      "Get-CimInstance Win32_Process " +
      "| Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match '_npx' -and $_.CommandLine -match 'pi-web|standalone' } " +
      "| Select-Object -ExpandProperty ProcessId";
    cp.exec(
      `powershell -NoProfile -Command "${ps}"`,
      { timeout: 15_000 },
      (e, out) => {
        if (e) return;
        for (const line of out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
          const pid = Number(line);
          if (pid > 0) kill(pid);
        }
      },
    );
    return;
  }
  cp.exec(
    `pgrep -f "npm-cache/_npx.*(pi-web|server\\.js)|_npx/.*/standalone/server\\.js"`,
    { timeout: 10_000 },
    (e, out) => {
      if (e) return;
      for (const line of out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        const pid = Number(line);
        if (pid > 0) kill(pid);
      }
    },
  );
}
