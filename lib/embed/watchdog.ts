// 空视图看门狗：会话页挂载后若「composer 在、消息行数为 0、无
// loading/error 门」持续存在，向宿主 output 报一条判别日志——把
// 「chrome 在、内容空」的两大成因一次切开：消息数据真空（fetch/状态
// 被覆盖）vs 渲染管线产 0 行（rows>0 但被 visibility 隐藏等）。
// DOM 驱动，不触 React 内部状态；embed 外为空操作。

import { embedParam, isEmbedMode, logToEmbedHost } from "./bridge.ts";

export interface ViewProbe {
  /** 渲染出的消息行数（每行带 data-entry-id）。 */
  rows: number;
  /** "正在加载会话" 全屏门——loadSession 未落定。 */
  loadingGate: boolean;
  /** 全屏错误门（.text-red-400）——loadSession 抛错。 */
  errorGate: boolean;
  /** 输入框已挂载——说明已过了 loading/error 门，进入正常分支。 */
  composer: boolean;
  /** 任一滚动容器被 visibility:hidden（pendingScrollRestore 类隐形）。 */
  scrollerHidden: boolean;
}

/**
 * 视图状态分类（判别日志的核心）：
 * - content：正常——有行且未隐藏
 * - hidden-rows：行在 DOM 里但被隐藏——渲染/隐藏路径的 wedge
 * - loading / error：还在门后——慢加载或已报错（非 wedge，但记录）
 * - empty-suspect：门已过、composer 在、0 行——数据侧 wedge 主嫌疑
 * - boot：连 composer 都没有——页面未挂载到聊天视图
 */
export function classifyView(p: ViewProbe): "content" | "hidden-rows" | "loading" | "error" | "empty-suspect" | "boot" {
  if (p.errorGate) return "error";
  if (p.loadingGate) return "loading";
  if (p.rows > 0) return p.scrollerHidden ? "hidden-rows" : "content";
  return p.composer ? "empty-suspect" : "boot";
}

function probeView(): ViewProbe {
  const rows = document.querySelectorAll("[data-entry-id]").length;
  const bodyText = document.body?.innerText ?? "";
  const loadingGate = rows === 0 && /loading session|正在加载会话/i.test(bodyText);
  const errorGate = Boolean(document.querySelector(".text-red-400"));
  const composer = Boolean(document.querySelector("textarea"));
  let scrollerHidden = false;
  for (const el of document.querySelectorAll<HTMLElement>(".overflow-y-auto")) {
    if (getComputedStyle(el).visibility === "hidden") {
      scrollerHidden = true;
      break;
    }
  }
  return { rows, loadingGate, errorGate, composer, scrollerHidden };
}

function report(sessionTag: string, when: string): void {
  try {
    const probe = probeView();
    const verdict = classifyView(probe);
    const flag = verdict === "empty-suspect" || verdict === "hidden-rows" ? "  <-- suspected wedge" : "";
    logToEmbedHost(
      `view-probe ${when}: rows=${probe.rows} gate=${verdict === "loading" ? "loading" : verdict === "error" ? "error" : "none"} ` +
      `composer=${probe.composer ? 1 : 0} hidden=${probe.scrollerHidden ? 1 : 0} → ${verdict}${flag} [${sessionTag}]`,
    );
  } catch {
    // 诊断不得影响页面本体。
  }
}

/**
 * 会话页挂载后做两次探针（3.5s 首报、9s 复核）：
 * 慢加载在首报里呈现 gate=loading，复核应恢复为 content；
 * wedge 两次都报同一嫌疑。页面重载即自动重挂。
 */
export function initEmbedDiagnostics(): void {
  if (typeof window === "undefined" || !isEmbedMode()) return;
  const sessionId = embedParam("session");
  if (!sessionId) return; // 非会话页（settings 壳等）不参与
  const tag = `s:${sessionId.slice(0, 8)}`;
  setTimeout(() => report(tag, "t+3.5s"), 3500);
  setTimeout(() => report(tag, "t+9s"), 9000);
}
