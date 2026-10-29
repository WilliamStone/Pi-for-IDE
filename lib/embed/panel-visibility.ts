// 宿主 panel.visible → 页面事件流挂起/恢复门。
//
// 背景：VS Code 隐藏 webview tab 不触发页面 visibility——后台 iframe 的
// document.visibilityState 恒为 "visible"（实测）。隐藏 iframe 里挂着的
// SSE 因此照占宿主的同源连接池（HTTP/1.1 约 6 条/主机上限），后台面板一
// 多会饿死新面板导航（settings 面板实测超时）。扩展按 WebviewPanel.visible
// 直推 panelVisible 通知；本门只做"何时释放/恢复"的判定：
//   false → suspend()；true → resume()（仅真挂起过才恢复，免掉首载多余重同步）。
export interface PanelVisibilityGateDeps {
  suspend(): void;
  resume(): void;
}

export function createPanelVisibilityGate(deps: PanelVisibilityGateDeps) {
  let suspended = false;
  return {
    handle(visible: boolean): void {
      if (!visible) {
        suspended = true;
        deps.suspend();
        return;
      }
      if (!suspended) return;
      suspended = false;
      deps.resume();
    },
    get suspended() {
      return suspended;
    },
  };
}
