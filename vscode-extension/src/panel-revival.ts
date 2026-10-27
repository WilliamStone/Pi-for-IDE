// 孤儿面板接管（扩展升级/宿主重启后 tab 还在、扩展侧对象已死）。
//
// deserializeWebviewPanel 是按 tab 懒触发的——恢复出的编辑器输入只在
// 成为组内活动编辑器（被渲染/被点开）时才 resolve → 命中已注册 reviver
// → deserialize → adopt() 原地接管（tab 位置与 DOM 全保）。后台孤儿
// 永不 resolve，也没有任何扩展侧 API 能强制它 resolve。因此：
//
//   可收养孤儿（session/composer/main/settings）——枚举即注册
//     serializer（裸 viewType，TabInputWebview.viewType 可能带
//     mainThreadWebview- 前缀，剥前缀由 barePiViewType 统一做），然后
//     留作"懒占位"：标题照常显示、不碍事；被点开即原地收养。永不扫尾——
//     关+重开换来的是闪烁与位置漂移，而占位符本身零成本。
//     枚举是响应式的：恢复路径晚于扩展激活才出现的 tab 靠
//     onDidChangeTabs/onExtraEnumerate 重扫补注册——resolve 早于注册
//     的惰性输入在 revivalPool 里等新 reviver，注册即排空，不丢。
//   不可收养孤儿（legacy 裸 piIde.webview）——身份不可考，deserialize
//     来了也映射不回，占位是纯陷阱：枚举即关。
//
// 树点开/reveal 命中孤儿占位 → 原位交换重开（OrphanRegistry.take*）：API
// 不给激活任意 tab 的能力，关占位+同列重开是最接近"激活"的等价物，且
// 杜绝与死 tab 并存的重影。手关/被收养/被取走的孤儿从登记处摘除。
//
// deserialize 分派按 kind：session 已不存在（清单已载而查无此会话）→
// 关窗自清理；composer 无 state 拿不到身份 → 关；main/settings → adopt
// 到对应单例。面板包壳与身份恢复在 webviewProvider.adopt()，viewType
// 解析在 session-panels.ts——本模块只做"枚举→注册→路由→登记"的编排。

import * as vscode from "vscode";
import {
  barePiViewType,
  parsePiViewType,
  type PiViewType,
  type SessionPanels,
} from "./session-panels";
import type { PiPanelPersistState, PiWebWebviewPanel } from "./webviewProvider";

/** 枚举时登记的孤儿 tab——kind/label/原列是交换重开时仅剩的位置与身份
 *  线索（deserialize 路径用不到它们，拿的是平台回传的 state）。 */
export interface OrphanTab {
  tab: vscode.Tab;
  /** 枚举时的原始形态（可能带 mainThreadWebview- 前缀）。 */
  providerVt: string;
  /** 裸 viewType——注册名、登记处键。 */
  rawVt: string;
  kind: PiViewType;
  /** 快照兜底——swap 时优先 live 读 tab.label/tab.group（用户可能拖过组）。 */
  label?: string;
  viewColumn?: vscode.ViewColumn;
}

/** 孤儿登记处：枚举填入，deserialize 收养/手关/交换取走时摘除。
 *  对 openSession/reveal 暴露 take*——取出即摘除（归调用方处置）。 */
export class OrphanRegistry {
  private readonly byTab = new Map<vscode.Tab, OrphanTab>();

  get size(): number {
    return this.byTab.size;
  }

  add(orphan: OrphanTab): void {
    this.byTab.set(orphan.tab, orphan);
  }

  /** 摘除：按 tab 对象（手关事件），或按 viewType（deserialize 侧只有
   *  panel.viewType；也兜 tab 移组换对象后手关事件对不上的情形——
   *  统一归一成裸值比对）。 */
  drop(ref: vscode.Tab | string): void {
    if (typeof ref !== "string") {
      this.byTab.delete(ref);
      return;
    }
    const raw = barePiViewType(ref);
    for (const [tab, orphan] of this.byTab) {
      if (orphan.rawVt === raw) this.byTab.delete(tab);
    }
  }

  /** 树点开同会话 → 取孤儿做原位交换。 */
  takeSession(id: string): OrphanTab | undefined {
    return this.takeWhere((o) => o.kind?.kind === "session" && o.kind.id === id);
  }

  /** main/settings 单例孤儿：reveal 前取走交换。 */
  takeKind(kind: "main" | "settings" | "composer"): OrphanTab | undefined {
    return this.takeWhere((o) => o.kind?.kind === kind);
  }

  private takeWhere(pred: (o: OrphanTab) => boolean): OrphanTab | undefined {
    for (const [tab, orphan] of this.byTab) {
      if (pred(orphan)) {
        this.byTab.delete(tab);
        return orphan;
      }
    }
    return undefined;
  }
}

export interface OrphanRevivalDeps {
  /** 会话/composer 面板注册表——deserialize 时按键收养。 */
  sessionPanels: SessionPanels;
  /** 主面板与设置面板单例——deserialize 时 adopt 接管。 */
  mainPanel: PiWebWebviewPanel;
  settingsPanel: PiWebWebviewPanel;
  /** 孤儿登记处——枚举填入；openSession/reveal 侧按需取走交换。 */
  orphans: OrphanRegistry;
  /** 会话是否仍在清单中：false=确认消失 → deserialize 收窗自清理；
   *  undefined=未知（清单未加载/服务未达）→ 乐观收养——误杀真孤儿的
   *  代价比多活一个占位高。 */
  sessionExists?: (sessionId: string) => boolean | undefined;
  /** 追加的重扫触发（如会话清单加载/刷新）——重载下编辑器恢复晚于
   *  扩展激活，单靠激活时枚举必输赛跑；onDidChangeTabs 之外再挂一道。 */
  onExtraEnumerate?: vscode.Event<unknown>;
  log: (line: string) => void;
}

export function registerOrphanPanelRevival(
  context: vscode.ExtensionContext,
  deps: OrphanRevivalDeps,
): void {
  const { sessionPanels, orphans, log } = deps;

  const dispatch = async (
    panel: vscode.WebviewPanel,
    kind: PiViewType,
    state?: PiPanelPersistState,
  ): Promise<void> => {
    switch (kind?.kind) {
      case "session":
        if (deps.sessionExists?.(kind.id) === false) {
          log(`[revive] session ${kind.id} no longer exists — closing orphan`);
          panel.dispose();
          return;
        }
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
    orphans.drop(barePiViewType(panel?.viewType ?? ""));
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

  // 该 viewType 已挂在活面板上 → 枚举到的 tab 不是孤儿。响应式枚举
  // 也会扫到本宿主正常新开的 tab——活面板进了孤儿登记处，树点开就会
  // 把它当死壳关掉重开，必须滤掉。serializer 仍照常注册：同 viewType
  // 若另有惰性输入 resolve，deserialize 走 adopt 重复键分支兜底关窗。
  const isLive = (rawVt: string): boolean => {
    for (const p of sessionPanels.all()) if (p.viewType === rawVt) return true;
    if (rawVt === "piIde.webview.main") {
      return deps.mainPanel.currentViewColumn !== undefined;
    }
    if (rawVt === "piIde.webview.settings") {
      return deps.settingsPanel.currentViewColumn !== undefined;
    }
    return false;
  };

  // 枚举现存 pi webview tab：注册新见 viewType 的 serializer（按裸值
  // 精确匹配，只能从 tabGroups 反推逐个注册）、把非活面板的 pi tab 登
  // 进孤儿登记处。裸 `piIde.webview`（旧版统一 viewType）身份不可考：
  // 不注册不留占位，见即关。
  //
  // 枚举做成可重入的三处驱动——激活一次、onDidChangeTabs、
  // onExtraEnumerate：窗口重载下编辑器恢复晚于扩展激活，一次性枚举
  // 必输赛跑（实测：激活时 tabGroups 尚空 → 零 serializer → 恢复出的
  // 惰性输入 resolve 后 revivalPool 里干等 → 全成死占位）。serializer
  // 注册晚于输入 resolve 无妨——池化输入等新 reviver 注册时排空，
  // deserialize 照到。
  const registered = new Set<string>();
  const enumerate = (): void => {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (!(input instanceof vscode.TabInputWebview)) continue;
        const kind = parsePiViewType(input.viewType);
        if (!kind) continue;
        if (kind.kind === "legacy") {
          log(`[revive] legacy orphan ${input.viewType} — closing (unrecoverable)`);
          void Promise.resolve(vscode.window.tabGroups.close(tab)).then(
            undefined,
            () => undefined,
          );
          continue;
        }
        const rawVt = barePiViewType(input.viewType);
        if (!registered.has(rawVt)) {
          registered.add(rawVt);
          log(`[revive] serializer registered for viewType=${rawVt}`);
          context.subscriptions.push(
            vscode.window.registerWebviewPanelSerializer(rawVt, {
              deserializeWebviewPanel: deserialize,
            }),
          );
        }
        if (isLive(rawVt)) continue;
        orphans.add({
          tab,
          providerVt: input.viewType,
          rawVt,
          kind,
          label: tab.label,
          viewColumn: tab.group?.viewColumn,
        });
      }
    }
  };

  // 先挂事件再跑首轮枚举——两步骤间出现的 tab 由事件兜底，不丢窗口。
  // closed 清理照旧：手关的孤儿摘除（按 viewType 兜底 tab 移组换对象
  // 后对不上的情形）。收养路径在 deserialize 里摘除，交换在 take* 里。
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      if (e.opened.length || e.changed.length) enumerate();
      for (const t of e.closed) {
        orphans.drop(t);
        const i = t.input;
        if (i instanceof vscode.TabInputWebview) orphans.drop(i.viewType);
      }
    }),
  );
  if (deps.onExtraEnumerate) {
    context.subscriptions.push(deps.onExtraEnumerate(() => enumerate()));
  }
  enumerate();
}
