/**
 * 回退纯逻辑——把 edit 的 newText/newText 对反序换回成 oldText。
 * 抽出为纯模块：这是静默数据损坏风险最高的地方，必须可单测。
 */

export interface RevertEdit {
  oldText: string;
  newText: string;
}

export type RevertApplyResult =
  | { ok: true; content: string }
  | { ok: false; reason: string };

/**
 * 反序 apply edits 把文件内容还原到改动前。
 * 每个 newText 必须恰好出现一次：0 次 = 已被外部改动，多次 = 替换目标
 * 不确定（pi 只约束 oldText 唯一，newText 可能撞文本）——都拒绝写。
 * replacer 用函数式，oldText 里的 `$&`、`$'`、`$n` 不被当模式解释。
 */
export function applyEditsReversed(content: string, edits: RevertEdit[]): RevertApplyResult {
  for (let i = edits.length - 1; i >= 0; i--) {
    const { oldText, newText } = edits[i];
    const occurrences = content.split(newText).length - 1;
    if (occurrences === 0) {
      return {
        ok: false,
        reason: `hunk ${i + 1}: new content not found in the file; it may have been modified externally`,
      };
    }
    if (occurrences > 1) {
      return {
        ok: false,
        reason: `hunk ${i + 1}: new content occurs ${occurrences} times; refusing ambiguous revert`,
      };
    }
    content = content.replace(newText, () => oldText);
  }
  return { ok: true, content };
}
