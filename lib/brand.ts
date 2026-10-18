import { isEmbedMode, embedHostId } from "@/lib/embed/bridge";

/** 独立运行的产品名：跟随上游 Pi Web 命名，"+" 表示含 IDE 适配等增强。 */
export const STANDALONE_APP_NAME = "Pi Web+";
/** embed 模式的默认显示名（vscode/vscodium 均用此）。 */
export const EMBED_APP_NAME = "Pi for IDE";

/** 按宿主 ID 映射 embed 显示名——未来其他宿主在此登记自有品牌。 */
const EMBED_HOST_APP_NAMES: Record<string, string> = {
  vscode: "Pi for IDE",
  vscodium: "Pi for IDE",
};

/** 当前界面的产品显示名；服务端渲染（无 window）按独立运行处理。 */
export function appDisplayName(): string {
  if (typeof window !== "undefined" && isEmbedMode()) {
    return EMBED_HOST_APP_NAMES[embedHostId() ?? ""] ?? EMBED_APP_NAME;
  }
  return STANDALONE_APP_NAME;
}
