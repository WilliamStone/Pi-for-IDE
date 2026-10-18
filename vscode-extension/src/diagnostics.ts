// 启动失败体检——从 piIdeServer.ts 拆出。
// 把解析链各环节、环境、端口占用、npm 日志尾部写入输出面板并给出可操作
// 的修复建议；最后弹"重试"按钮。

import * as cp from "child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { managedPackageBin } from "./managedRuntime";
import { scanPortOccupiers } from "./port-scan";
import { resolveGlobalPackageBin, resolvePathShimBin, SpawnTarget } from "./server-resolve";

export async function reportStartupFailure(
  channel: vscode.OutputChannel,
  context: vscode.ExtensionContext,
  pkg: string,
  target: SpawnTarget,
): Promise<void> {
  channel.appendLine("—— startup failure diagnostics ——");
  const tryCmd = (cmd: string): Promise<string> =>
    new Promise((r) =>
      cp.exec(cmd, { timeout: 8000 }, (e, out) =>
        r(e ? "unavailable" : out.trim().split("\n")[0] || "?"),
      ),
    );
  channel.appendLine(`node@PATH: ${await tryCmd("node -v")} (requires ≥ 22.19)`);
  channel.appendLine(`npm@PATH: ${await tryCmd("npm -v")}`);
  channel.appendLine(`pnpm@PATH: ${await tryCmd("pnpm -v")}`);

  // 解析链各环节现状——指出哪条腿能用、哪条断了。
  const configured = vscode.workspace
    .getConfiguration("Pi for IDE")
    .get<string>("executablePath")
    ?.trim();
  channel.appendLine(
    `resolve chain: executablePath=${configured ? (existsSync(configured) ? "exists" : "missing!") : "unset"}; ` +
      `global package=${(await resolveGlobalPackageBin(pkg)) ?? "not installed"}; ` +
      `shim=${(await resolvePathShimBin(pkg)) ?? "none"}; ` +
      `managed runtime=${managedPackageBin(context, pkg) ?? "missing"}; ` +
      `mode=${target.mode}`,
  );

  // 端口占用：3030-3039 谁在监听（含 PID/命令行/身份分类）。
  const occupiers = await scanPortOccupiers(undefined, undefined, pkg);
  if (!occupiers.length) {
    channel.appendLine("port 303x occupants: none");
  } else {
    for (const o of occupiers) {
      channel.appendLine(
        `port ${o.port}: PID ${o.pid} [${o.kind}] ${o.cmdline.slice(-140) || "(no cmdline)"}`,
      );
    }
  }

  // 最近一次 npm 日志尾部（npx/托管安装的 EBUSY 等真因都在里面）。
  const logsDir =
    process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA ?? "", "npm-cache", "_logs")
      : path.join(process.env.HOME ?? "", ".npm", "_logs");
  try {
    const latest = readdirSync(logsDir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => ({ f, t: statSync(path.join(logsDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    if (latest && Date.now() - latest.t < 30 * 60_000) {
      const tail = readFileSync(path.join(logsDir, latest.f), "utf8")
        .split("\n")
        .filter((l) => /error|EBUSY|EPERM|EACCES|ENOENT/i.test(l))
        .slice(-15);
      if (tail.length) {
        channel.appendLine(`npm log ${latest.f} tail:\n  ${tail.join("\n  ")}`);
      }
    }
  } catch {
    // 无日志目录就算了。
  }

  channel.appendLine(
    "Suggestions: 1) read the log above for the root cause; 2) run \"Pi for IDE: Stop Server\" and retry " +
      "(a listed [ours] PID is an orphan from another window — kill it via taskkill /PID <pid> /T /F); " +
      "3) install the package globally to skip the runtime download: pnpm add -g " + pkg + "@latest.",
  );

  const pick = await vscode.window.showErrorMessage(
    "Pi for IDE server failed to start; diagnostics were written to the output panel (Pi for IDE).",
    "View Output",
    "Stop && Retry",
    "Close",
  );
  if (pick === "View Output") channel.show(true);
  if (pick === "Stop && Retry") {
    // stop 标记 disposed → ensureStarted 会另起全新实例；走完整 open
    // 命令顺带把面板 refresh 到新地址。
    void vscode.commands.executeCommand("piIde.stop");
    void vscode.commands.executeCommand("piIde.open");
  }
}
