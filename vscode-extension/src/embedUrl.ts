// 嵌入页 URL 契约——此前参数规则散落在 webviewProvider.refresh 的内联
// 构造里（cwd/session 冲突那条甚至只活在注释），页面侧解析规则在另一
// 个仓库层。集中成一个纯函数后，参数组合规则可测、改一处双方都看见。
//
// 参数契约（页面侧消费）：
//   embed=vscode      恒带——页面据此判定嵌入模式
//   session=<id>      会话深链。**与 cwd 互斥**：页面把 ?cwd= 解释为
//                     "该目录的新会话草稿"，同传会让草稿盖掉深链、
//                     停在首页（曾踩）。所以 session 存在时绝不带 cwd。
//   cwd=<path>        无 session 时的目录锚点（composer/完整页）。
//   view=chat|settings 精简视图——应用侧栏与多余顶栏由宿主原生 UI 取代
//   section=<id>      仅 view=settings：直达设置小节
//   browserBtn=0|1    仅 view=chat：chat 顶栏"在浏览器中打开"可见性
//   extVer=<ver>      扩展版本（页面侧能力协商/显示）
//   evProxy=1         宿主声明支持 EventSource 代理——页面据此把
//                     window.EventSource 换成桥接实现（旧宿主不发，
//                     页面回退原生 EventSource）
//   inst=<boot>       服务器实例标识——同端口重启的新实例 URL 仍不同，
//                     shell 的 loadedUrl 判重不会吞掉，iframe 必然换页
export interface EmbedUrlOptions {
  /** 服务器实例标识（embedBoot）。 */
  inst: string;
  /** 扩展版本。 */
  extVer: string;
  /** 会话深链 id——与 cwd 互斥，存在时 cwd 不发出。 */
  sessionId?: string;
  /** 目录锚点（无 session 时）。 */
  cwd?: string;
  /** 精简视图："chat" | "settings"。缺省 = 完整应用页。 */
  view?: string;
  /** view=settings 的目标小节。 */
  section?: string;
  /** view=chat 的"在浏览器中打开"可见性（页面参数 0/1）。 */
  browserBtn?: boolean;
  /** 宿主支持 EventSource 代理（页面据 evProxy=1 启用桥接 EventSource）。 */
  eventProxy?: boolean;
}

export function buildEmbedUrl(origin: string, opts: EmbedUrlOptions): string {
  const url = new URL(origin);
  url.searchParams.set("embed", "vscode");
  if (opts.sessionId) {
    url.searchParams.set("session", opts.sessionId);
  } else if (opts.cwd) {
    url.searchParams.set("cwd", opts.cwd);
  }
  if (opts.view) url.searchParams.set("view", opts.view);
  if (opts.view === "settings" && opts.section) {
    url.searchParams.set("section", opts.section);
  }
  if (opts.view === "chat" && opts.browserBtn !== undefined) {
    url.searchParams.set("browserBtn", opts.browserBtn ? "1" : "0");
  }
  url.searchParams.set("extVer", opts.extVer);
  if (opts.eventProxy) url.searchParams.set("evProxy", "1");
  url.searchParams.set("inst", opts.inst);
  return url.toString();
}
