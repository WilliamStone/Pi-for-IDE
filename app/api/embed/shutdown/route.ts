import { NextResponse } from "next/server";
import { embedShutdownAllowed, requestEmbedShutdown } from "@/lib/embed/lifecycle";

// 优雅停机：attach 来的宿主不持有本进程句柄，靠这个端点关停共享服务器。
// 许可判据（lib/embed/lifecycle.ts）：存在"可证明的另一个使用方"就 409
// 拒绝——旧版宿主的 ≠判据+attach也stop 谋杀链在这里被服务端收权；
// 显式 Stop 可带 {client, force:true} 强制。回环/鉴权由 proxy.ts 统一兜底。
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const client = typeof body?.client === "string" && body.client ? body.client : undefined;
  if (body?.force !== true) {
    const { allowed, others } = embedShutdownAllowed(client);
    if (!allowed) {
      return NextResponse.json({ error: "in-use", clients: others }, { status: 409 });
    }
  }
  requestEmbedShutdown(0);
  return new NextResponse(null, { status: 204 });
}
