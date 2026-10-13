import { NextResponse } from "next/server";

// Embed 模式探测端点。
//
// 嵌入宿主（如 VSCode 扩展）在外部启动一个 pi-web 实例后，需要区分所连
// 服务器是否包含 embed 桥补丁——原版 pi-web 没有此路由（404），打过补丁
// 的返回 200 + 协议版本。宿主据此决定是否启用桥能力或提示安装正确版本。
const EMBED_PROTOCOL_VERSION = 1;

export function GET() {
  return NextResponse.json({ embed: { protocol: EMBED_PROTOCOL_VERSION } });
}
