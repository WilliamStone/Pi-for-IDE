import { NextResponse } from "next/server";
import { requestEmbedShutdown } from "@/lib/embed/lifecycle";

// 优雅停机：attach 来的宿主不持有本进程句柄（this.child 为空），靠这个
// 端点关停共享服务器。回环/鉴权由 proxy.ts 统一兜底。
export function POST() {
  requestEmbedShutdown(0);
  return new NextResponse(null, { status: 204 });
}
