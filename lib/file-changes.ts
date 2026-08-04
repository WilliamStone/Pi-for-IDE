/**
 * 从一轮对话（turn）的 messages 里提取「文件改动」清单。
 *
 * 一轮 turn = 一个 user message（或 compaction 锚点）→ 中间的 assistant
 * process（工具调用）→ 最终的 final assistant answer。
 *
 * 数据源是 pi-web 已持有的 messages state，零额外 API 调用：
 *   - assistant 消息的 toolCall block：toolName + input（含 path/content/edits）
 *   - toolResult 消息：details.diff（edit 工具的统一 diff）、isError
 *
 * 工具类型与可提取信息：
 *   edit  → input.path + result.details.diff（统一 diff，含 before/after 行）
 *   write → input.path + input.content（完整新内容，无 diff）
 *   bash  → 无法静态提取改了哪些文件，列为 untracked
 */

import type { AgentMessage, AssistantMessage, ToolCallContent, ToolResultMessage } from "./types";

export type FileChangeKind = "edit" | "write" | "bash" | "other";

export interface FileChange {
  /** 文件绝对路径。bash/other 类型可能为空（无法确定）。 */
  path: string;
  /** 相对 cwd 的路径，用于显示。无法确定时等于 path。 */
  relativePath: string;
  /** 触发改动的工具名。 */
  toolName: string;
  /** toolCallId，关联 session 里的 entry。 */
  toolCallId: string;
  /** 变更类型分类。 */
  kind: FileChangeKind;
  /** edit 工具的统一 diff 文本（来自 result.details.diff）。 */
  diffText?: string;
  /** edit 工具的原始替换对（来自 input.edits），用于回退时反向 apply。 */
  edits?: { oldText: string; newText: string }[];
  /** write 工具的完整新内容（来自 input.content）。 */
  newContent?: string;
  /** 是否为创建新文件（write 且磁盘上原本不存在）。前端无法确定，留给扩展判断。 */
  changeType: "modified" | "created" | "unknown";
  /** 该工具调用是否报错。 */
  isError: boolean;
}

/**
 * 是否是会修改文件内容的工具名。
 * 与 components/MessageView.tsx 的 isEditToolName 保持一致。
 */
export function isEditToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "edit" ||
    name.startsWith("edit_") ||
    name.endsWith(".edit") ||
    name.endsWith("_edit") ||
    name.includes("str_replace") ||
    name.includes("replace_editor");
}

function isWriteToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "write" ||
    name.startsWith("write_") ||
    name.endsWith(".write") ||
    name.endsWith("_write");
}

function isBashToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "bash" || name === "shell" || name.endsWith(".bash");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从 toolResult.details 提取统一 diff 文本（edit 工具）。 */
function getDiffFromResult(result: ToolResultMessage): string | undefined {
  const details = (result as ToolResultMessage & { details?: unknown }).details;
  if (!isRecord(details)) return undefined;
  const patch = typeof details.patch === "string" ? details.patch : null;
  if (patch) return patch;
  const diff = typeof details.diff === "string" ? details.diff : null;
  if (diff) return diff;
  return undefined;
}

/** 把绝对路径转成相对 cwd 的路径（用于显示）。 */
function toRelativePath(absPath: string, cwd: string | undefined): string {
  if (!cwd) return absPath;
  // 规范化 cwd 末尾斜杠，避免 /a/b vs /a/b/ 比较失败
  const normCwd = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  if (absPath.startsWith(normCwd + "/")) {
    return absPath.slice(normCwd.length + 1);
  }
  return absPath;
}

/**
 * 从一条 assistant 消息里抽出所有 toolCall blocks。
 */
function getToolCallBlocks(msg: AssistantMessage): ToolCallContent[] {
  const content = msg.content;
  if (!Array.isArray(content)) return [];
  const blocks: ToolCallContent[] = [];
  for (const block of content) {
    if (block.type === "toolCall") {
      // 兼容两种字段命名（pi 文件格式用 id/name/arguments，前端类型用 toolCallId/toolName/input）
      const tc = block as unknown as Partial<ToolCallContent> & {
        id?: string; name?: string; arguments?: Record<string, unknown>;
      };
      blocks.push({
        type: "toolCall",
        toolCallId: tc.toolCallId ?? tc.id ?? "",
        toolName: tc.toolName ?? tc.name ?? "",
        input: tc.input ?? tc.arguments ?? {},
      });
    }
  }
  return blocks;
}

/**
 * 从一轮 turn 的 messages 里提取 FileChange[]。
 *
 * @param messages  本轮 turn 范围内的所有消息（含 user、assistant、toolResult）
 * @param cwd       session 的工作目录，用于把绝对路径转相对路径
 * @returns         去重后的 FileChange 列表（同一文件被多次改取最后一次的有效信息）
 *
 * 注：bash 工具无法静态确定改了哪些文件，会产出一个 path 为空的「untracked」
 * 条目，前端据此渲染提示而非具体文件。
 */
export function extractFileChanges(
  messages: AgentMessage[],
  cwd?: string,
): FileChange[] {
  // 先建 toolCallId → toolResult 的索引
  const resultsByCallId = new Map<string, ToolResultMessage>();
  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    const tr = msg as ToolResultMessage;
    if (tr.toolCallId) resultsByCallId.set(tr.toolCallId, tr);
  }

  // 按 path 去重：同一文件多次改动，合并为一条，取最后出现的信息
  const byPath = new Map<string, FileChange>();
  const orderedPaths: string[] = [];
  let bashUntrackedAdded = false;

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const blocks = getToolCallBlocks(msg as AssistantMessage);
    for (const tc of blocks) {
      const result = resultsByCallId.get(tc.toolCallId);
      const isError = result?.isError ?? false;

      // 跳过报错的工具调用（没真正改文件）
      if (isError) continue;

      const toolName = tc.toolName;
      const input = tc.input;

      if (isEditToolName(toolName)) {
        const path = typeof input.path === "string" ? input.path : "";
        if (!path) continue;
        const diffText = result ? getDiffFromResult(result) : undefined;
        // 提取原始 edits（oldText/newText 对），用于回退时反向 apply
        const rawEdits = Array.isArray(input.edits) ? input.edits : [];
        const edits = rawEdits
          .filter((e: unknown): e is Record<string, string> =>
            !!e && typeof e === "object" && typeof (e as { oldText?: unknown }).oldText === "string" && typeof (e as { newText?: unknown }).newText === "string")
          .map((e) => ({ oldText: e.oldText, newText: e.newText }));
        const change: FileChange = {
          path,
          relativePath: toRelativePath(path, cwd),
          toolName,
          toolCallId: tc.toolCallId,
          kind: "edit",
          diffText,
          edits,
          changeType: "modified",
          isError,
        };
        if (!byPath.has(path)) orderedPaths.push(path);
        byPath.set(path, change);
      } else if (isWriteToolName(toolName)) {
        const path = typeof input.path === "string" ? input.path : "";
        if (!path) continue;
        const content = typeof input.content === "string" ? input.content : "";
        const change: FileChange = {
          path,
          relativePath: toRelativePath(path, cwd),
          toolName,
          toolCallId: tc.toolCallId,
          kind: "write",
          newContent: content,
          changeType: "created",
          isError,
        };
        if (!byPath.has(path)) orderedPaths.push(path);
        byPath.set(path, change);
      } else if (isBashToolName(toolName)) {
        // bash 可能改文件但无法静态提取，只产一个 untracked 标记
        if (!bashUntrackedAdded) {
          bashUntrackedAdded = true;
          // 用特殊 key 标记，不进 byPath（无具体文件）
          orderedPaths.push("__bash_untracked__");
          byPath.set("__bash_untracked__", {
            path: "",
            relativePath: "",
            toolName,
            toolCallId: tc.toolCallId,
            kind: "bash",
            changeType: "unknown",
            isError,
          });
        }
      }
      // 其他工具不产出文件改动条目
    }
  }

  return orderedPaths.map((p) => byPath.get(p)!).filter(Boolean);
}
