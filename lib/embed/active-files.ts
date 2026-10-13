// embed 模式：把宿主当前活动编辑器文件注入 system prompt 的隐藏段。
// LLM 可见、UI 不显示、不落盘到 session 文件。用 marker 包裹，下次 prompt
// 前先把旧注入剥掉再拼新的，避免 setActiveTools/reload 重建 base 后残留。
//
// 注意：本模块触碰 pi SDK AgentSession 的内部字段（_baseSystemPrompt /
// agent.state.systemPrompt）——pi-web 经进程内 SDK 接入 pi，暂无公开扩展点，
// 是本 delta 中对上游最脆弱的一处依赖，升级 pi SDK 时需优先回归验证。

const MARK_START = "\n\n<!-- pi-web:active-files -->\n";
const MARK_END = "\n<!-- /pi-web:active-files -->";

interface AgentSessionInternals {
  _baseSystemPrompt?: string;
  agent: { state: { systemPrompt: string } };
}

/**
 * 在 prompt 发出前，把 activeFiles 注入 AgentSession 内部的 system prompt。
 * 旧注入段（若存在）先剥掉再拼新段；activeFiles 为空时仅做剥除。
 */
export function applyActiveFilesHint(inner: unknown, activeFiles: string[] | undefined): void {
  const innerAny = inner as AgentSessionInternals;
  let base = innerAny._baseSystemPrompt ?? "";
  const startIdx = base.indexOf(MARK_START);
  if (startIdx !== -1) {
    const endIdx = base.indexOf(MARK_END, startIdx);
    if (endIdx !== -1) {
      base = base.slice(0, startIdx) + base.slice(endIdx + MARK_END.length);
    }
  }
  if (activeFiles && activeFiles.length > 0) {
    base +=
      MARK_START +
      "[宿主当前打开的编辑器文件]\n" +
      activeFiles.join("\n") +
      "\n[说明：若你的修改目标涉及上述文件，优先直接修改这些正在打开的文件。]" +
      MARK_END;
  }
  if (innerAny._baseSystemPrompt !== undefined) {
    innerAny._baseSystemPrompt = base;
    innerAny.agent.state.systemPrompt = base;
  }
}

/** 从 systemPrompt 里剥掉 active-files 注入段，返回纯用户可见版本。 */
export function stripActiveFilesHint(systemPrompt: string): string {
  const startIdx = systemPrompt.indexOf(MARK_START);
  if (startIdx === -1) return systemPrompt;
  const endIdx = systemPrompt.indexOf(MARK_END, startIdx);
  if (endIdx === -1) return systemPrompt;
  return systemPrompt.slice(0, startIdx) + systemPrompt.slice(endIdx + MARK_END.length);
}
