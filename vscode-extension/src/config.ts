// 配置段常量与访问器——"Pi for IDE" 字面量此前散在 12+ 处
// getConfiguration 调用里，拼错静默失败。集中后改段名/查引用都只有一处。
import * as vscode from "vscode";

export const CONFIG_SECTION = "Pi for IDE";

/** `vscode.workspace.getConfiguration("Pi for IDE")` 的统一入口。 */
export function piConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}
