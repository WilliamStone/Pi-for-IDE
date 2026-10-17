import { isEmbedMode } from "@/lib/embed/bridge";

/** 独立运行的产品名：跟随上游 Pi Web 命名，"+" 表示含 IDE 适配等增强。 */
export const STANDALONE_APP_NAME = "Pi Web+";
/** embed 模式的显示名：跟随宿主扩展身份（pi-for-ide）。 */
export const EMBED_APP_NAME = "Pi for IDE";

/** 当前界面的产品显示名；服务端渲染（无 window）按独立运行处理。 */
export function appDisplayName(): string {
  if (typeof window !== "undefined" && isEmbedMode()) return EMBED_APP_NAME;
  return STANDALONE_APP_NAME;
}
