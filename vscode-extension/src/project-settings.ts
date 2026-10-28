// `<cwd>/.pi/settings.json` 直达编辑器——Pi Sessions 视图菜单与树
// 右键共用。pi 严格按 cwd 解析项目级设置（不向上找 projectRoot），
// 目标目录由调用方按入口语义给出（视图→配置 cwd；项目→group.root；
// 会话→session.cwd）。
//
// 文件不存在时开"路径绑定的 untitled"：磁盘零写入，用户保存时才落
// 盘（`.pi/` 由 VS Code 保存路径自动创建）。
//
// 骨架只给 "{}"——settings 逐键覆盖，键存在即遮蔽全局同名键；预填
// 任何键（含 enabledModels: []）保存即静默创建项目级覆盖。Models
// 面板的项目清单创建是有确认的用户动作，这里必须是一张白纸。
import * as vscode from "vscode";
import { existsSync } from "fs";
import { join } from "path";

/** `<dir>/.pi/settings.json` — pi 项目级设置文件路径。 */
export function projectSettingsFile(dir: string): string {
  return join(dir, ".pi", "settings.json");
}

/** 新文件骨架：合法 JSON、零覆盖键。 */
export const PROJECT_SETTINGS_SKELETON = "{\n  \n}\n";

/** 打开 `<dir>/.pi/settings.json`：存在→普通文件；不存在→绑定该
 *  路径的 untitled + 骨架，保存才写入。 */
export async function openProjectSettings(dir: string): Promise<void> {
  const target = vscode.Uri.file(projectSettingsFile(dir));
  if (existsSync(target.fsPath)) {
    await vscode.window.showTextDocument(target);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(target.with({ scheme: "untitled" }));
  // 先注入骨架再显示：untitled 打开即脏，显示后注入的窗口里用户
  // Ctrl+S 会落出空文件（坏 JSON）——WorkspaceEdit 不需可见编辑器。
  const we = new vscode.WorkspaceEdit();
  we.insert(doc.uri, new vscode.Position(0, 0), PROJECT_SETTINGS_SKELETON);
  await vscode.workspace.applyEdit(we);
  const editor = await vscode.window.showTextDocument(doc);
  const caret = new vscode.Position(1, 2);
  editor.selection = new vscode.Selection(caret, caret);
}
