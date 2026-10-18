// embed 模式：把宿主当前活动编辑器文件注入 system prompt 的隐藏段。
// LLM 可见、UI 不显示、不落盘到 session 文件之外的持久态。
//
// 实现：before_agent_start 挂钩返回注入后的投影（与 exact-system-prompt 同
// 一文档化机制）。早于该版本的做法是直接写 SDK 私有字段
// _baseSystemPrompt/agent.state.systemPrompt——内部实现一改就静默失效，
// 且 replay 重建后注入丢失；改为每轮投影后不再需要 marker 剥除来维持
// "只保留最新一份"语义（marker 仍保留：transcript 会持久化投影后的
// prompt，UI 展示仍靠 stripActiveFilesHint 剥除）。

import type { InlineExtension } from "@earendil-works/pi-coding-agent";

const MARK_START = "\n\n<!-- pi-web:active-files -->\n";
const MARK_END = "\n<!-- /pi-web:active-files -->";

export const ACTIVE_FILES_EXTENSION_NAME = "pi-web-active-files";

/** before_agent_start 事件的最小形状（SDK 类型未导出时自描述）。 */
interface BeforeAgentStartEvent {
  systemPrompt?: string;
}

/**
 * 每轮 prompt 前在系统提示词投影尾部拼上 active-files 段。
 * `getActiveFiles` 每轮都重新读——宿主编辑器焦点变了下一轮即生效；
 * 返回空/未定义则不修改投影。
 * event.systemPrompt 可能已带上一轮注入（transcript replay），先剥再拼，
 * 与直接写私有字段时"换文件后残两份"的缺陷天然绝缘。
 */
export function createActiveFilesExtension(
  getActiveFiles: () => string[] | undefined,
): InlineExtension {
  return {
    name: ACTIVE_FILES_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
        const activeFiles = getActiveFiles();
        if (!activeFiles?.length) return undefined;
        const base = stripActiveFilesHint(event.systemPrompt ?? "");
        return {
          systemPrompt:
            base +
            MARK_START +
            "[宿主当前打开的编辑器文件]\n" +
            activeFiles.join("\n") +
            "\n[说明：若你的修改目标涉及上述文件，优先直接修改这些正在打开的文件。]" +
            MARK_END,
        };
      });
    },
  };
}

/** 从 systemPrompt 里剥掉 active-files 注入段，返回纯用户可见版本。 */
export function stripActiveFilesHint(systemPrompt: string): string {
  const startIdx = systemPrompt.indexOf(MARK_START);
  if (startIdx === -1) return systemPrompt;
  const endIdx = systemPrompt.indexOf(MARK_END, startIdx);
  if (endIdx === -1) return systemPrompt;
  return systemPrompt.slice(0, startIdx) + systemPrompt.slice(endIdx + MARK_END.length);
}
