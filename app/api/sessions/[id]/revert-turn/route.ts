import { NextResponse } from "next/server";
import { readFileSync, writeFileSync } from "fs";
import {
  resolveSessionPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
} from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";

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

    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    type SessionEntry = { id?: string; parentId?: string | null; type?: string };
    const entries = lines.map((l) => {
      try { return JSON.parse(l) as SessionEntry; }
      catch { return null; }
    }).filter((e): e is SessionEntry => !!e && typeof e.id === "string");

    // 找到该轮用户消息（第一个被删 entry）的 parentId，用于重连 children
    const firstEntry = entries.find((e) => deleted.has(e.id!));
    const prevParentId = firstEntry?.parentId ?? null;

    // 判断被删集合里是否有 session header —— 不允许删 header
    const headerIdx = entries.findIndex((e) => e.type === "session");
    if (headerIdx >= 0 && entries[headerIdx].id && deleted.has(entries[headerIdx].id)) {
      return NextResponse.json({ error: "Cannot delete session header" }, { status: 400 });
    }

    const kept = entries
      .filter((e) => e.id && !deleted.has(e.id))
      .map((e) => {
        // children 重连到被删轮之前的父节点
        if (e.parentId && deleted.has(e.parentId)) {
          return { ...e, parentId: prevParentId };
        }
        return e;
      });

    if (kept.length === 0) {
      return NextResponse.json({ error: "Cannot delete all entries" }, { status: 400 });
    }

    writeFileSync(filePath, kept.map((e) => JSON.stringify(e)).join("\n") + "\n");

    // 服务端 wrapper 持有旧状态 → destroy，下次请求重新加载
    getRpcSession(id)?.destroy();
    invalidateSessionPathCache(id);
    invalidateSessionListCache();

    return NextResponse.json({ ok: true, kept: kept.length });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
