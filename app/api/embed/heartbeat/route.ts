import { NextResponse } from "next/server";
import { recordEmbedHeartbeat } from "@/lib/embed/lifecycle";

// 宿主心跳：重置生命周期 watchdog 的静默计时。独立实例（watchdog 未武装）
// 收到也是无害 no-op；鉴权/回环限制由 proxy.ts 统一兜底。
export function POST() {
  recordEmbedHeartbeat();
  return new NextResponse(null, { status: 204 });
}
