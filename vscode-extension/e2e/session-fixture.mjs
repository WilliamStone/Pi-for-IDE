// 预置会话 fixture：在独立的 PI_CODING_AGENT_DIR 里写一份含
// write/edit/drifted-edit toolCall 的 JSONL，pi-web 启动后可直接浏览。
// 覆盖 B 段手工清单的三种路径，不用真跑 agent：
//   written.txt —— write 产物且未被再改（after 可直接读）
//   edited.txt  —— edit 后停在 newText（反放可重建 before → 双侧 diff）
//   drifted.txt —— edit 记录后又被改动（reconstructBefore 失败 →
//                  openText 降级 + "在本轮后又被修改" 提示）
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** pi 的 cwd→sessions 子目录 slug：`--` + 分隔符/冒号全转 `-` + `--` */
export function sessionDirName(cwd) {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

const WRITTEN_CONTENT = "created by e2e seed\nline2\n";
const OLD_TEXT = "alpha\nbeta\n";
const NEW_TEXT = "alpha\nbeta-edited\ngamma\n";
const DRIFTED_NOW = "unrelated content\n";

const EDIT_DIFF = [
  "--- a/edited.txt", "+++ b/edited.txt", "@@ -1,2 +1,3 @@",
  " alpha", "-beta", "+beta-edited", "+gamma", "",
].join("\n");
const WRITE_DIFF = [
  "--- /dev/null", "+++ b/written.txt", "@@ -0,0 +1,2 @@",
  "+created by e2e seed", "+line2", "",
].join("\n");
const DRIFT_DIFF = [
  "--- a/drifted.txt", "+++ b/drifted.txt", "@@ -1 +1 @@",
  "-before", "+after", "",
].join("\n");

export function seedSession(root, workspace) {
  const agentDir = path.join(root, "agent");
  const dir = path.join(agentDir, "sessions", sessionDirName(workspace));
  mkdirSync(dir, { recursive: true });

  const files = {
    written: path.join(workspace, "written.txt"),
    edited: path.join(workspace, "edited.txt"),
    drifted: path.join(workspace, "drifted.txt"),
  };
  writeFileSync(files.written, WRITTEN_CONTENT);
  writeFileSync(files.edited, NEW_TEXT);
  writeFileSync(files.drifted, DRIFTED_NOW);

  const t = Date.now();
  const iso = (d) => new Date(t + d).toISOString();
  const msg = (role, content, extra) => ({ role, content, timestamp: t, ...extra });
  const entries = [
    { type: "session", version: 3, id: "e2e-seed-01", timestamp: iso(0), cwd: workspace },
    { type: "message", id: "e2u1", parentId: null, timestamp: iso(1),
      message: msg("user", [{ type: "text", text: "e2e seed turn" }]) },
    { type: "message", id: "e2a1", parentId: "e2u1", timestamp: iso(2),
      message: msg("assistant", [
        { type: "toolCall", id: "e2write", name: "write",
          arguments: { path: files.written, content: WRITTEN_CONTENT } },
        { type: "toolCall", id: "e2edit", name: "edit",
          arguments: { path: files.edited, edits: [{ oldText: OLD_TEXT, newText: NEW_TEXT }] } },
        { type: "toolCall", id: "e2drift", name: "edit",
          arguments: { path: files.drifted, edits: [{ oldText: "before\n", newText: "after\n" }] } },
      ], { api: "openai-completions", provider: "e2e", model: "e2e", stopReason: "toolUse" }) },
    { type: "message", id: "e2r1", parentId: "e2a1", timestamp: iso(3),
      message: msg("toolResult", [{ type: "text", text: "ok" }],
        { toolCallId: "e2write", toolName: "write", isError: false, details: { diff: WRITE_DIFF } }) },
    { type: "message", id: "e2r2", parentId: "e2r1", timestamp: iso(4),
      message: msg("toolResult", [{ type: "text", text: "ok" }],
        { toolCallId: "e2edit", toolName: "edit", isError: false, details: { diff: EDIT_DIFF } }) },
    { type: "message", id: "e2r3", parentId: "e2r2", timestamp: iso(5),
      message: msg("toolResult", [{ type: "text", text: "ok" }],
        { toolCallId: "e2drift", toolName: "edit", isError: false, details: { diff: DRIFT_DIFF } }) },
    { type: "message", id: "e2a2", parentId: "e2r3", timestamp: iso(6),
      message: msg("assistant", [{ type: "text", text: "done" }],
        { api: "openai-completions", provider: "e2e", model: "e2e", stopReason: "stop" }) },
  ];
  const name = `${iso(0).replace(/:/g, "-").replace(/\./g, "-")}_e2eseed01.jsonl`;
  const sessionFile = path.join(dir, name);
  writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { agentDir, sessionFile, files };
}
