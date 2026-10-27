// 会话面板注册表：tab 与会话/项目键一一对应。
// 键形态：会话 id 或 `new:<cwd>`（composer 面板）。composer 落地成真会话后
// 经页面的 sessionSelected 桥消息 re-key 到会话 id——之后点树复用同一 tab。
// dispose 按"面板→键"反查删除（闭包旧键在 re-key 后已失效）。
// createPanel 走注入工厂——re-key/归属逻辑可脱离 webview 直接测。

import type * as vscode from "vscode";
import type { PiPanelPersistState, PiWebWebviewPanel } from "./webviewProvider";

/** viewType 命名解析（每面板唯一）：
 *  `piIde.webview.s.<sessionId>` 会话 | `piIde.webview.n<seq>` composer |
 *  `piIde.webview.main` / `.settings` 单例 | 裸 `piIde.webview` 旧版统一
 *  形态（身份不可考，不参与 revive）。TabInputWebview.viewType 正常是
 *  裸值，个别渠道可能带 mainThreadWebview- 前缀——剥掉再判。 */
export type PiViewType =
  | { kind: "session"; id: string }
  | { kind: "composer" }
  | { kind: "main" }
  | { kind: "settings" }
  | { kind: "legacy" }
  | undefined;

/** 剥 providerId 前缀拿裸 viewType——TabInputWebview.viewType 是
 *  `mainThreadWebview-<viewType>` 形态；序列化注册、revived 标记、
 *  面板归属比较等一切按 viewType 判等的场合都必须走它，两边形态
 *  不一致会静默错配（扫尾把已收养活面板当孤儿关掉）。 */
export function barePiViewType(viewType: string): string {
  return viewType.startsWith("mainThreadWebview-")
    ? viewType.slice("mainThreadWebview-".length)
    : viewType;
}

export function parsePiViewType(viewType: string): PiViewType {
  const vt = barePiViewType(viewType);
  if (vt === "piIde.webview") return { kind: "legacy" };
  if (vt === "piIde.webview.main") return { kind: "main" };
  if (vt === "piIde.webview.settings") return { kind: "settings" };
  if (vt.startsWith("piIde.webview.s.")) return { kind: "session", id: vt.slice(16) };
  if (/^piIde\.webview\.n\d+$/.test(vt)) return { kind: "composer" };
  return undefined;
}

export interface SessionPanelsDeps {
  /** 面板工厂：宿主侧注入 PiWebWebviewPanel 的真实构造（含订阅注册）。
   *  viewType 每面板唯一——tab 右键菜单的 resource URI 反查归属用。 */
  createPanel: (
    viewType: string,
    onDisposed: () => void,
    onSessionBound: (sessionId: string, title?: string) => void,
  ) => PiWebWebviewPanel;
  /** 没有任何已开面板时的落点列（openBeside 语义的出口）。 */
  fallbackColumn: () => vscode.ViewColumn;
}

export class SessionPanels implements vscode.Disposable {
  private readonly panels = new Map<string, PiWebWebviewPanel>();
  private readonly owned = new Set<PiWebWebviewPanel>();
  private readonly deps: SessionPanelsDeps;
  private nextSeq = 1;

  constructor(deps: SessionPanelsDeps) {
    this.deps = deps;
  }

  /** 取/建键对应的面板——点同一 session/composer 键复用其 tab。 */
  forKey(key: string): PiWebWebviewPanel {
    const existing = this.panels.get(key);
    if (existing) return existing;
    // 回调只会在面板生命周期事件里异步触发——p 必然已赋值。
    // viewType 每面板唯一：session 用 id（可预期——利于日后 serializer
    // 按 id 注册复活），composer 是瞬态用序号即可。
    const viewType = key.startsWith("new:")
      ? `piIde.webview.n${this.nextSeq++}`
      : `piIde.webview.s.${key}`;
    const p = this.deps.createPanel(
      viewType,
      () => this.deleteKeyOf(p),
      (sessionId, title) => this.rekey(p, sessionId, title),
    );
    this.panels.set(key, p);
    this.owned.add(p);
    return p;
  }

  /**
   * 会话 tab 的固定落点：任一已开会话面板所在组——首个面板按 openBeside
   * 开列，后续全进同一组（tab 叠放），不随活动编辑器漂移。
   */
  column(): vscode.ViewColumn {
    return (
      [...this.panels.values()]
        .map((p) => p.currentViewColumn)
        .find((c) => c !== undefined) ?? this.deps.fallbackColumn()
    );
  }

  /** 全部活面板（re-key 后归属变了面板本身不变）。 */
  all(): Iterable<PiWebWebviewPanel> {
    return this.panels.values();
  }

  /** 当前激活的会话面板——tab 右键命令的归属反查（同时只有一个 editor 激活）。 */
  active(): PiWebWebviewPanel | undefined {
    for (const p of this.panels.values()) if (p.isActive) return p;
    return undefined;
  }

  /** 接管 serializer revive 的孤儿 tab：复用既有 vscode.WebviewPanel
   *  （面板包壳内按它重渲染/重接桥），注册进 key 映射。同键已有活面板
   *  时关掉多余孤儿，返回既有面板。 */
  async adopt(
    key: string,
    panel: vscode.WebviewPanel,
    state?: PiPanelPersistState,
  ): Promise<PiWebWebviewPanel> {
    const existing = this.panels.get(key);
    if (existing) {
      panel.dispose();
      return existing;
    }
    // 既有面板的 viewType 保持不变——包装壳按真实值建（URI 反查继续命中）。
    // deserialize 到手的 panel.viewType 形态随平台变，先归一成裸值。
    const p = this.deps.createPanel(
      barePiViewType(panel.viewType),
      () => this.deleteKeyOf(p),
      (sessionId, title) => this.rekey(p, sessionId, title),
    );
    this.panels.set(key, p);
    this.owned.add(p);
    p.adopt(panel, state, key.startsWith("new:") ? undefined : key);
    return p;
  }

  /** 按 tab resource URI 反查面板：path 形如
   *  `webview-panel/webview-<providerId>-<uuid>`（providerId =
   *  mainThreadWebview-<viewType>）——viewType 每面板唯一，内含即归属。
   *  用 `vt + "-"` 匹配：uuid 段以 - 分隔，排除序号型 viewType 的前后缀
   *  碰撞（n1 vs n12）。 */
  byViewTypeUri(path: string): PiWebWebviewPanel | undefined {
    for (const p of this.panels.values()) {
      const vt = p.viewType;
      // `${vt}-`：uuid 段以 - 分隔，排除序号型 viewType 的前后缀碰撞
      // （n1 vs n12）。endsWith 兜底接管面板 viewType 带完整
      // `mainThreadWebview-…-uuid` 形态（等于 path 尾段）的情形。
      if (vt && (path.includes(`${vt}-`) || path.endsWith(vt))) return p;
    }
    return undefined;
  }

  private deleteKeyOf(panel: PiWebWebviewPanel): void {
    for (const [k, v] of this.panels) if (v === panel) this.panels.delete(k);
  }

  /** composer（new:<cwd> 键）落地为真会话 → 重挂到会话 id 键。 */
  private rekey(panel: PiWebWebviewPanel, sessionId: string, title?: string): void {
    if (this.panels.get(sessionId) === panel) return;
    this.deleteKeyOf(panel);
    if (!this.panels.has(sessionId)) this.panels.set(sessionId, panel);
    if (title) panel.setTitleOverride(`Pi — ${title.slice(0, 50)}`);
  }

  dispose(): void {
    for (const p of this.owned) p.dispose();
    this.panels.clear();
    this.owned.clear();
  }
}
