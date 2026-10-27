// 孤儿面板接管与扫尾（扩展升级/宿主重启后 tab 还在、扩展侧对象已死）。
//
// 两条路径殊途同归：
//   收养 —— 对每个枚举到的 pi viewType 注册 WebviewPanelSerializer，
//     VS Code 为存活面板回调 deserializeWebviewPanel → adopt() 原地接管
//     （tab 位置保留、无关闭闪烁；注册必须按裸 viewType，枚举到的
//     TabInputWebview.viewType 是 mainThreadWebview- 前缀的 providerId
//     形态，剥前缀由 barePiViewType 统一做）。
//   扫尾 —— deserialize 是否/何时触发取决于平台语义（重载恢复路径、
//     宿主重启、版本差异；实测 VSCodium 1.140 有注册了却永不回调的
//     情形）。宽限期后仍没被认领的孤儿判定死态：关掉、按 kind 重开等价
//     活 tab。composer 无 state 拿不到 cwd、legacy 无身份——只关不重开。
//     宽限期内被用户手动关掉的 tab 不重开（尊重显式关闭）。
//
// 面板包壳与身份恢复在 webviewProvider.adopt()，viewType 解析在
// session-panels.ts——本模块只做"枚举→注册→路由→扫尾"的编排。

import * as vscode from "vscode";
import {
  barePiViewType,
  parsePiViewType,
  type PiViewType,
  type SessionPanels,
} from "./session-panels";
import type { PiPanelPersistState, PiWebWebviewPanel } from "./webviewProvider";

/** 扫尾重开时透传给调用方的孤儿 tab 现场——deserialize 不来时 state
 *  拿不到，tab 自带的 label/viewColumn 是仅剩的身份与位置线索。 */
export interface OrphanInfo {
  /** 死 tab 标题（session tab 是 "Pi — <name>" 形态，解析归调用方）。 */
  label?: string;
  /** 死 tab 原所在组——尽量回摆原列；组已消失时由宿主落位。 */
  viewColumn?: vscode.ViewColumn;
}

export interface OrphanRevivalDeps {
  /** 会话/composer 面板注册表——deserialize 时按键收养。 */
  sessionPanels: SessionPanels;
  /** 主面板与设置面板单例——deserialize 时 adopt 接管。 */
  mainPanel: PiWebWebviewPanel;
  settingsPanel: PiWebWebviewPanel;
  /** 扫尾关死 tab 后的等价重开（session→树里的打开动作，main/settings→reveal）。
   *  orphan 带上死 tab 的 label/原列——调用方据以恢复标题与落位。 */
  reopenSession: (sessionId: string, orphan?: OrphanInfo) => unknown;
  reopenMain: () => unknown;
  reopenSettings: () => unknown;
  log: (line: string) => void;
  /** 扫尾宽限期（ms）。默认 5s——deserialize 在可用的平台语义下随注册
   *  近乎即达，宽限只兜"来晚了"的情形；不来的环境（实测存在）里它就是
   *  死 tab 的滞留时长，不宜拉长。 */
  sweepGraceMs?: number;
}

const DEFAULT_SWEEP_GRACE_MS = 5000;

interface OrphanTab {
  tab: vscode.Tab;
  /** 枚举时的原始形态（可能带 mainThreadWebview- 前缀）——手关比对用。 */
  providerVt: string;
  /** 裸 viewType——注册名、revived 键。 */
  rawVt: string;
  kind: PiViewType;
  /** 枚举时快照的死 tab 现场（扫尾时 tab 已关，读属性不可靠——先存）。 */
  label?: string;
  viewColumn?: vscode.ViewColumn;
}

export function registerOrphanPanelRevival(
  context: vscode.ExtensionContext,
  deps: OrphanRevivalDeps,
): void {
  const { sessionPanels, log } = deps;
  const revived = new Set<string>();

  const dispatch = async (
    panel: vscode.WebviewPanel,
    kind: PiViewType,
    state?: PiPanelPersistState,
  ): Promise<void> => {
    switch (kind?.kind) {
      case "session":
        await sessionPanels.adopt(kind.id, panel, state);
        return;
      case "composer": {
        // 已落地会话的 composer 持 sessionId；否则按 cwd 回 new:<cwd> 键；
        // 两者皆无的孤儿救不回有用状态——关掉。
        const sid = typeof state?.sessionId === "string" && state.sessionId ? state.sessionId : "";
        const cwd = typeof state?.cwd === "string" && state.cwd ? state.cwd : "";
        const key = sid || (cwd ? `new:${cwd}` : "");
        if (!key) {
          panel.dispose();
          return;
        }
        await sessionPanels.adopt(key, panel, state);
        return;
      }
      case "main":
        deps.mainPanel.adopt(panel, state);
        return;
      case "settings":
        deps.settingsPanel.adopt(panel, state);
        return;
      default:
        panel.dispose();
    }
  };

  const deserialize = async (
    panel: vscode.WebviewPanel,
    state: PiPanelPersistState | undefined,
  ): Promise<void> => {
    // 先记触达行——deserialize 若抛错，入口日志仍留证（失败默吞会
    // 表现得像"serializer 没被调用"，排障无据可依）。
    log(`[revive] deserialize fired viewType=${String(panel?.viewType)} state=${JSON.stringify(state ?? null)}`);
    revived.add(barePiViewType(panel?.viewType ?? ""));
    try {
      await dispatch(panel, parsePiViewType(panel?.viewType ?? ""), state);
    } catch (e) {
      log(`[revive] adopt failed: ${String(e)}`);
      try {
        panel.dispose();
      } catch {
        /* 已死 */
      }
    }
  };

  // 枚举现存 pi webview tab——serializer 按 viewType 精确匹配，viewType
  // 是动态值，只能从 tabGroups 反推逐注册。裸 `piIde.webview`（旧版统一
  // viewType）身份不可考：不注册 serializer，但仍进孤儿清单扫尾关掉。
  const registered = new Set<string>();
  const orphans: OrphanTab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (!(input instanceof vscode.TabInputWebview)) continue;
      const kind = parsePiViewType(input.viewType);
      if (!kind) continue;
      const rawVt = barePiViewType(input.viewType);
      orphans.push({
        tab,
        providerVt: input.viewType,
        rawVt,
        kind,
        label: tab.label,
        viewColumn: tab.group?.viewColumn,
      });
      if (kind.kind === "legacy") continue;
      if (registered.has(rawVt)) continue;
      registered.add(rawVt);
      log(`[revive] serializer registered for viewType=${rawVt}`);
      context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer(rawVt, {
          deserializeWebviewPanel: deserialize,
        }),
      );
    }
  }
  if (orphans.length === 0) return;

  // 宽限期内被用户手动关掉的孤儿：扫尾不得把它们再开回来。
  const closedOrphans = new Set<vscode.Tab>();
  const closedViewTypes = new Set<string>();
  const tabEvents = vscode.window.tabGroups.onDidChangeTabs((e) => {
    for (const t of e.closed) {
      closedOrphans.add(t);
      const i = t.input;
      if (i instanceof vscode.TabInputWebview) closedViewTypes.add(i.viewType);
    }
  });
  context.subscriptions.push(tabEvents);

  const sweep = (): void => {
    for (const { tab, providerVt, rawVt, kind, label, viewColumn } of orphans) {
      if (revived.has(rawVt)) continue;
      if (closedOrphans.has(tab) || closedViewTypes.has(providerVt)) continue;
      log(`[revive] no deserialize for ${rawVt} — closing dead tab`);
      void Promise.resolve(vscode.window.tabGroups.close(tab)).then(
        (closed) => {
          // close 返回 false = tab 已不在（用户关了/平台清了）——不重开。
          if (!closed) return;
          const reopen =
            kind?.kind === "session"
              ? deps.reopenSession(kind.id, { label, viewColumn })
              : kind?.kind === "main"
                ? deps.reopenMain()
                : kind?.kind === "settings"
                  ? deps.reopenSettings()
                  : undefined; // composer/legacy：只关不重开
          // 重开是 fire-and-forget——失败（含 reject）只损失一个 tab，
          // 不外溢成 unhandled rejection 噪声。
          void Promise.resolve(reopen).then(undefined, () => undefined);
        },
        () => undefined,
      );
    }
  };
  const sweepTimer = setTimeout(sweep, deps.sweepGraceMs ?? DEFAULT_SWEEP_GRACE_MS);
  context.subscriptions.push({ dispose: () => clearTimeout(sweepTimer) });
}
