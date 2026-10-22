// 会话面板注册表：tab 与会话/项目键一一对应。
// 键形态：会话 id 或 `new:<cwd>`（composer 面板）。composer 落地成真会话后
// 经页面的 sessionSelected 桥消息 re-key 到会话 id——之后点树复用同一 tab。
// dispose 按"面板→键"反查删除（闭包旧键在 re-key 后已失效）。
// createPanel 走注入工厂——re-key/归属逻辑可脱离 webview 直接测。

import type * as vscode from "vscode";
import type { PiWebWebviewPanel } from "./webviewProvider";

export interface SessionPanelsDeps {
  /** 面板工厂：宿主侧注入 PiWebWebviewPanel 的真实构造（含订阅注册）。 */
  createPanel: (
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

  constructor(deps: SessionPanelsDeps) {
    this.deps = deps;
  }

  /** 取/建键对应的面板——点同一 session/composer 键复用其 tab。 */
  forKey(key: string): PiWebWebviewPanel {
    const existing = this.panels.get(key);
    if (existing) return existing;
    // 回调只会在面板生命周期事件里异步触发——p 必然已赋值。
    // eslint-disable-next-line prefer-const -- 闭包先行声明，构造后回填。
    let p!: PiWebWebviewPanel;
    p = this.deps.createPanel(
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
