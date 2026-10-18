import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import {
  resolveSessionPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
} from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import { revertTurnEntries, type SessionEntryLike } from "@/lib/turn-revert";

/**
 * POST /api/sessions/[id]/revert-turn  body: { entryIds: string[] }
 *
 * 回退某一轮：删除会话文件中该轮的所有 entry（用户消息及其后的
 * assistant/toolResult 等）。文件直接重写（pi 自身也会整文件重写）。
 *
 * parentId 链处理：被删 entry 的 children 需要重连到「该轮用户消息的
 * parentId」，否则后面的轮次会断链，buildSessionPath 找不到父节点。
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { entryIds } = await req.json() as { entryIds?: unknown };
    if (!Array.isArray(entryIds) || entryIds.length === 0) {
      return NextResponse.json({ error: "entryIds is required" }, { status: 400 });
    }
    const deleted = new Set(entryIds.map((e) => String(e)));

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // wrapper 运行中会并发 append——读改写窗口内新 entry 会被静默覆盖，
    // 直接拒绝；页面侧回退按钮本就以 sessionBusy 门控。
    if (getRpcSession(id)?.isRunning()) {
      return NextResponse.json({ error: "Session is busy" }, { status: 409 });
    }

    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const entries = lines.map((l) => {
      try { return JSON.parse(l) as SessionEntryLike; }
      catch { return null; }
    }).filter((e): e is SessionEntryLike => !!e && typeof e.id === "string");

    const result = revertTurnEntries(entries, deleted);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    writePrivateFileAtomicSync(filePath, result.kept.map((e) => JSON.stringify(e)).join("\n") + "\n");

    // 服务端 wrapper 持有旧状态 → destroy，下次请求重新加载
    getRpcSession(id)?.destroy();
    invalidateSessionPathCache(id);
    invalidateSessionListCache();

    return NextResponse.json({ ok: true, kept: result.kept.length });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
