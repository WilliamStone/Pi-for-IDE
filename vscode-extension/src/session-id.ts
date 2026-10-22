// 会话命令参数 → 会话 id 归一——纯函数、无 vscode 依赖（可直测）。
// view/item 命令参数形态不一（TreeItem 对象、字符串、节点点击的
// [id,title] 元组），不归一就是 ?session=[object Object] 那种 bug。

/** TreeItem/裸参数 → 会话 id；无 id 抛错（防线）。 */
export function sessionIdOf(item: { id?: string }): string {
  const id = item.id?.replace(/^piIde\.session\./, "");
  if (!id) throw new Error("session item missing id");
  return id;
}
