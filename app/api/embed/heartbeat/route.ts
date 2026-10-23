import { NextResponse } from "next/server";
import { recordEmbedHeartbeat } from "@/lib/embed/lifecycle";

// 宿主心跳：重置生命周期 watchdog 的静默计时 + 登记客户端身份
// （shutdown 的"别窗在用就拒绝"判据靠它）。旧版宿主不带 body——
// 归匿名桶 ""，无害且同样计为一个使用方。鉴权/回环由 proxy.ts 统一兜底。
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  recordEmbedHeartbeat(typeof body?.client === "string" ? body.client : "");
  return new NextResponse(null, { status: 204 });
}
