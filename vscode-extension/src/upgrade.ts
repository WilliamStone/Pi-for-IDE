// 升级编排层——"有可升级动作"的全部用户触达路径收口在这一个文件：
//   1) resolve 降级警告（server-resolve 上抛的事件，这里消费）
//   2) 激活 +8s 后台检查（checkForUpdates 开启时）
//   3) 手动 piIde.upgrade / piIde.versions 命令
// 三条路径共用 planUpgrade 判定 + upgradeNotice 共享签名——同一动作
// 本会话只弹一次框。新增第四条提示路径时，也只能从这里的共享标记过。

import * as vscode from "vscode";
import { piConfig } from "./config";
import {
  installManagedLocalPackage,
  installManagedPackage,
  levelSupported,
  listManagedVersions,
  setManagedMarker,
  sweepManagedVersions,
} from "./managedRuntime";
import { outputChannel } from "./server-status";
import { formatBuildStamp } from "./version";
import {
  installPiWebPackage,
  onDowngradeWarning,
  planUpgrade,
  type UpgradeAction,
} from "./server-resolve";
import { markUpgradeSurfaced, upgradeActionSig, wasUpgradeSurfaced } from "./upgradeNotice";

export interface UpgradeDeps {
  /** 本窗口当前服务器 promise（未启动为空）。 */
  server: () => Promise<{ stop(): Promise<void>; disposed?: boolean } | undefined> | undefined;
  /** 按需拉起服务器。 */
  ensureServer: () => Promise<unknown>;
  /** 重启后重指所有已开面板到新实例。 */
  refreshAllPanels: () => Promise<void>;
}

/** 注册升级相关的全部触达路径（resolve 警告消费 / 后台检查 / 两条命令）。 */
export function registerUpgradeSurfaces(
  context: vscode.ExtensionContext,
  deps: UpgradeDeps,
): void {
  const fmtBuild = formatBuildStamp;
  const ch = () => outputChannel();

  /** 装完后的收尾提示：有运行中服务器问重启；没有也要给一句交代（静默成功像死按钮）。 */
  const restartPrompt = async (label: string): Promise<void> => {
    const running = await deps.server();
    if (running && !running.disposed) {
      const r = await vscode.window.showInformationMessage(
        `${label} Restart the server to apply.`,
        "Restart Server",
        "Later",
      );
      if (r === "Restart Server") {
        await running.stop();
        await deps.ensureServer();
        // 实例已换——已打开的面板重指到新 origin（refresh 内部判断
        // 实例变化才重推 URL，shell 探测后就绪了再换 iframe）。
        await deps.refreshAllPanels();
      }
      // 其他窗口的面板经实例标记自动刷新（需那边也跑新版扩展）；
      // 浏览器里打开的 tab 扩展够不着——提示用户手动 reload。
      void vscode.window.showInformationMessage(
        "Pi for IDE server updated. Panels in other windows switch over on their own; reload any browser tabs open to the old server (F5) to pick up the new build.",
      );
      return;
    }
    void vscode.window.showInformationMessage(`${label} Takes effect on next server start.`);
  };

  /**
   * 按升级计划动作执行安装 + 收尾。命令的 Install/Upgrade 与后台通知
   * 的 Install 共用同一路径——后台那一下点击就是直接装，不弹第二层确认。
   */
  const applyUpgradeAction = async (
    a: Exclude<UpgradeAction, { kind: "none" }>,
    pkg: string,
    localTgz: string,
  ): Promise<void> => {
    if (a.kind === "local") {
      const ok = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Installing ${pkg} from local tarball…` },
        (progress) =>
          installManagedLocalPackage(ch(), context, localTgz, (m) =>
            progress.report({ message: m }),
          ),
      );
      if (!ok) {
        void vscode.window.showErrorMessage(`${pkg} local install failed — see the Pi for IDE output panel for details.`);
        return;
      }
      await restartPrompt(`${pkg} installed from local tarball (${a.label}).`);
      return;
    }
    // a.kind === "registry"
    const ok = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Upgrading ${pkg}…` },
      (progress) =>
        a.managed
          ? installManagedPackage(ch(), context, pkg, a.version, (msg) =>
              progress.report({ message: msg }),
            )
          : installPiWebPackage(ch(), pkg, a.version),
    );
    if (!ok) {
      void vscode.window.showErrorMessage(
        `${pkg} upgrade failed — see the Pi for IDE output panel for details.`,
      );
      return;
    }
    await restartPrompt(`${pkg} upgraded to ${a.version}.`);
  };

  // -----------------------------------------------------------------------
  // 触达路径 1：resolve 降级警告——"已解析副本比本地包旧"事件的消费端。
  // 共享标记拦重；Upgrade 按钮 direct 直装，不再开第二层确认。
  // -----------------------------------------------------------------------
  context.subscriptions.push(
    onDowngradeWarning(({ warn, sig }) => {
      if (wasUpgradeSurfaced(sig)) {
        ch().appendLine("  (same upgrade already prompted this session — notification skipped)");
        return;
      }
      markUpgradeSurfaced(sig);
      void vscode.window
        .showWarningMessage(`Pi for IDE: ${warn}.`, "Upgrade", "Later")
        .then((pick) => {
          if (pick === "Upgrade") void vscode.commands.executeCommand("piIde.upgrade", { direct: true });
        });
    }),
  );

  // 升级命令：采集各侧候选 → 报告对照（来源设置/各侧版本/当前版本）→
  // 结论 → 确认 → 安装 → 重启本窗口服务器。托管运行时走版本目录
  // （不碰运行中的旧目录）；全局安装走包管理器原地升级。
  context.subscriptions.push(
    vscode.commands.registerCommand("piIde.upgrade", async (opts?: { direct?: boolean }) => {
      const cfg = piConfig();
      const pkg = (cfg.get<string>("package") ?? "").trim() || "@william_stone/pi-web-for-ide";
      // 安装来源选择（Pi for IDE.installSource）：
      //   auto          = 两边比，同版本→本地；localPackage 没填只有在线候选；
      //   prefer-remote = 两边比，同版本→在线；
      //   local / registry = 单边锁死。
      const installSource = (cfg.get<string>("installSource") ?? "auto").trim();
      const localTgz = (cfg.get<string>("localPackage") ?? "").trim();
      if (installSource === "local" && !localTgz) {
        void vscode.window.showErrorMessage("Pi for IDE: installSource is local but localPackage is not set.");
        return;
      }

      // 升级计划（planUpgrade）：采集→对照报告→flow→动作——与后台检查
      // 共用同一判定；这里只负责渲染与执行。registry 探测最坏 ~15s 静默，
      // 先上个进度浮窗（曾踩"点了 Upgrade 半天没反应"）。
      const plan = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Checking pi-web upgrade sources…",
          cancellable: false,
        },
        () => planUpgrade(context, pkg, installSource, localTgz),
      );

      // 完整对照写输出通道；浮窗单行结论 + Details… 开通道看全表。
      ch().appendLine(`\n=== upgrade check — installSource: ${installSource} ===`);
      for (const l of plan.report) ch().appendLine(`  ${l}`);
      const DETAILS = "Details…";
      const showDetails = (pick?: string) => {
        // show() 不带 preserveFocus——Details 的意图就是"给我看"，面板
        // 要抢焦点出现；show(true) 只把通道开在不抢焦点的位置，用户看不到。
        if (pick === DETAILS) ch().show();
        return pick === DETAILS;
      };
      const curLabel = plan.current ? `${plan.current.version}${fmtBuild(plan.current.builtAt)}` : "none";

      const a = plan.action;
      if (a.kind !== "none") markUpgradeSurfaced(upgradeActionSig(a));
      // direct 模式（resolve 警告等上游入口）：动作确定就直接装——用户
      // 已经在警告框里同意过升级，再弹一层确认是重复打扰。
      if (opts?.direct && (a.kind === "registry" || (a.kind === "local" && a.recommended))) {
        await applyUpgradeAction(a, pkg, localTgz);
        return;
      }
      if (a.kind === "none") {
        // 本地侧有具体失败原因时优先呈现——"already at latest" 只描述
        // registry 半边的结论，本地包缺失/被拒的真相被埋在 Details 里
        // 会误导（曾踩：tgz 消失→提示已最新，实际是本地侧空）。
        const localReason = plan.local?.reason;
        const msg = `${pkg}: ${localReason ? `local: ${localReason}; ` : ""}${a.reason}.`;
        showDetails(
          await (a.reason.startsWith("already at") && !localReason
            ? vscode.window.showInformationMessage(msg, DETAILS)
            : a.reason.includes("requires a newer") || a.reason.includes("refused") || localReason
              ? vscode.window.showWarningMessage(msg, DETAILS)
              : vscode.window.showErrorMessage(msg, DETAILS)),
        );
        return;
      }
      if (a.kind === "local") {
        const pick = await vscode.window.showInformationMessage(
          `Local build ${a.label} is ${a.recommended ? "newer" : "not newer"} than current ${curLabel}.`,
          a.recommended ? "Install" : "Install Anyway",
          DETAILS,
          "Cancel",
        );
        if (showDetails(pick)) return;
        if (!pick?.startsWith("Install")) return;
        await applyUpgradeAction(a, pkg, localTgz);
        return;
      }

      // a.kind === "registry"
      const pick = await vscode.window.showInformationMessage(
        `${pkg} ${a.version} is available (current: ${curLabel}).${a.managed ? " Instances in other windows are unaffected and switch on restart." : ""}`,
        "Upgrade Now",
        DETAILS,
        "Later",
      );
      if (showDetails(pick)) return;
      if (pick !== "Upgrade Now") return;
      await applyUpgradeAction(a, pkg, localTgz);
    }),
  );

  // 管理服务器版本（兜底）：列出已装托管版本（级别/兼容性标注），
  // 支持切换 marker（含降级）与清理非当前版本。
  context.subscriptions.push(
    vscode.commands.registerCommand("piIde.versions", async () => {
      const pkg =
        (piConfig().get<string>("package") ?? "").trim() ||
        "@william_stone/pi-web-for-ide";
      const versions = listManagedVersions(context, pkg);
      type Item = vscode.QuickPickItem & { action: "switch" | "cleanup"; version?: string };
      const items: Item[] = versions.map((v) => ({
        label: `${v.current ? "$(star-full) " : ""}${v.version}`,
        description:
          `level ${v.level ?? "unknown"}${levelSupported(v.level) ? "" : " (unsupported by this extension)"}` +
          `${v.builtAt ? ` ·${formatBuildStamp(v.builtAt)}` : ""}` +
          `${v.ready ? "" : " (bin missing)"}${v.current ? " · current" : ""}`,
        detail: v.dir,
        action: "switch",
        version: v.version,
      }));
      items.push({ label: "$(trash) Clean up non-current versions", action: "cleanup" });
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: "Managed server versions — switching takes effect after restart (cleanup only removes versions below the current one)",
      });
      if (!pick) return;
      if (pick.action === "cleanup") {
        await sweepManagedVersions(context, outputChannel());
        void vscode.window.showInformationMessage("Pi for IDE: old versions cleaned up (directories in use were skipped).");
        return;
      }
      if (!pick.version) return;
      setManagedMarker(context, pick.version);
      const r = await vscode.window.showInformationMessage(
        `Switched to ${pick.version}. Restart the server to apply.`,
        "Restart Server",
        "Later",
      );
      if (r === "Restart Server") {
        const running = await deps.server();
        await running?.stop();
        await deps.ensureServer();
      }
    }),
  );

  // -------------------------------------------------------------------------
  // 触达路径 2：后台升级检查（激活 +8s、静默失败）
  // 通知只告知有新版本；按钮统一走 piIde.upgrade 命令（同一条编排路径）。
  // -------------------------------------------------------------------------
  if (!piConfig().get<boolean>("checkForUpdates", true)) return;
  const timer = setTimeout(() => {
    void (async () => {
      const pkg =
        (piConfig().get<string>("package") ?? "").trim() ||
        "@william_stone/pi-web-for-ide";
      // 安装来源语义与 piIde.upgrade 完全一致——同一个 planUpgrade：
      // 后台检查只是"有计划可装时发个通知"，判定逻辑零重复。
      const cfgUpd = piConfig();
      const installSource = (cfgUpd.get<string>("installSource") ?? "auto").trim();
      const localTgz = (cfgUpd.get<string>("localPackage") ?? "").trim();
      if (installSource === "local" && !localTgz) return;
      const plan = await planUpgrade(context, pkg, installSource, localTgz);
      const cur = plan.current ? `${plan.current.version}${fmtBuild(plan.current.builtAt)}` : "none";
      const a = plan.action;
      // 与命令一致的通道报告——Details 按钮开的表就在这里。
      ch().appendLine(`\n=== upgrade check (auto) — installSource: ${installSource} ===`);
      for (const l of plan.report) ch().appendLine(`  ${l}`);
      // 同一动作刚由 resolve 警告/手动命令提示过 → 只留报告不再弹框。
      const sig = upgradeActionSig(a);
      if (a.kind !== "none" && wasUpgradeSurfaced(sig)) {
        ch().appendLine("  (same upgrade already prompted this session — notification skipped)");
        return;
      }
      if (a.kind !== "none") markUpgradeSurfaced(sig);
      const DETAILS = "Details…";
      const showDetails = (pick?: string) => {
        if (pick === DETAILS) ch().show();
        return pick === DETAILS;
      };
      if (a.kind === "local" && a.recommended) {
        const pick = await vscode.window.showInformationMessage(
          `Local build ${a.label} is newer than current ${cur}.`,
          "Install",
          DETAILS,
          "Later",
        );
        if (showDetails(pick)) return;
        // Install 就是直接装——后台通知本身就是确认，不再弹命令的第二层。
        if (pick === "Install") await applyUpgradeAction(a, pkg, localTgz);
      } else if (a.kind === "registry") {
        const pick = await vscode.window.showInformationMessage(
          `${pkg} ${a.version} is available (current: ${cur}).`,
          "Upgrade Now",
          DETAILS,
          "Later",
        );
        if (showDetails(pick)) return;
        if (pick === "Upgrade Now") await applyUpgradeAction(a, pkg, localTgz);
      } else if (a.kind === "none" && a.reason.includes("requires a newer")) {
        // 包太新需要升级扩展——这值得单独提醒。
        void vscode.window.showInformationMessage(`${pkg}: ${a.reason}.`);
      }
      // 其余 none / 未推荐的本地构建 → 静默（手动跑升级命令能看到完整对照）。
    })();
  }, 8000);
  context.subscriptions.push({ dispose: () => clearTimeout(timer) });
}
