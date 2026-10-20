import { NextResponse } from "next/server";
import { embedCapabilities } from "@/lib/embed/lifecycle";

// Embed 模式探测端点。
//
// 嵌入宿主（如 VSCode 扩展）在外部启动一个 pi-web 实例后，需要区分所连
// 服务器是否包含 embed 桥补丁——原版 pi-web 没有此路由（404），打过补丁
// 的返回 200 + 协议版本 + 能力表。宿主据此决定是否启用桥能力或提示安装正确版本。
const EMBED_PROTOCOL_VERSION = 1;

// 进程实例标识：模块加载即定型 = 本次启动时间戳。宿主据此区分"同一服务
// 器还在"与"服务器重启过"（升级换包后旧 iframe 需要换页）。
const BOOT_ID = String(Date.now());

export function GET() {
  // version 供宿主做版本/协议兼容性提示（扩展据此判断该升级哪一侧）。
  // capabilities：可选特性按名探测，缺失即降级（docs/agents/embed-protocol.md）。
  // boot：本进程实例标识——跨进程重启后必变，宿主比它判断要不要刷新嵌入页。
  return NextResponse.json({
    embed: {
      protocol: EMBED_PROTOCOL_VERSION,
      version: process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0",
      boot: BOOT_ID,
      capabilities: embedCapabilities(),
    },
  });
}
