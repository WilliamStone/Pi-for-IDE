// 预置会话 fixture：在独立的 PI_CODING_AGENT_DIR 里写一份含
// write/edit/drifted-edit toolCall 的 JSONL，pi-web 启动后可直接浏览。
// 覆盖 B 段手工清单的三种路径，不用真跑 agent：
//   written.txt —— write 产物且未被再改（after 可直接读）
//   edited.txt  —— edit 后停在 newText（反放可重建 before → 双侧 diff）
//   drifted.txt —— edit 记录后又被改动（reconstructBefore 失败 →
//                  openText 降级 + "在本轮后又被修改" 提示）
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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

export function seedSession(root, workspace, opts = {}) {
  const id = opts.id ?? "e2e-seed-01";
  const firstMessage = opts.firstMessage ?? "e2e seed turn";
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
    { type: "session", version: 3, id, timestamp: iso(0), cwd: workspace },
    { type: "message", id: "e2u1", parentId: null, timestamp: iso(1),
      message: msg("user", [{ type: "text", text: firstMessage }]) },
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
  const name = `${iso(0).replace(/:/g, "-").replace(/\./g, "-")}_${id.replace(/-/g, "")}.jsonl`;
  const sessionFile = path.join(dir, name);
  writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { agentDir, sessionFile, files };
}

/**
 * 活体档用的配置复制：把真 agent 目录里的模型/设置搬到 fixture
 * agentDir（本机文件拷贝——apiKey 只落在用户自己的磁盘上，
 * 绝不进仓库）。真目录没配 defaultModel 时返回 null → 测试 skip。
 */
export async function seedAgentConfig(agentDir) {
  const real = path.join(homedir(), ".pi", "agent");
  const settingsPath = path.join(real, "settings.json");
  const modelsPath = path.join(real, "models.json");
  if (!existsSync(settingsPath) || !existsSync(modelsPath)) return null;
  let settings, models;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    models = JSON.parse(readFileSync(modelsPath, "utf8"));
    if (!settings?.defaultProvider || !settings?.defaultModel) return null;
  } catch { return null; }

  // 引擎实际加载的模型可能换了 id（如 bonsai2 → bonsai2-mtp）——
  // 探测 provider 的 /v1/models，把 defaultModel 校正到真实可用的那个；
  // 探不通说明引擎没起 → 返回 null 让测试 skip。
  const provider = models?.providers?.[settings.defaultProvider];
  if (!provider?.baseUrl) return null;
  try {
    const base = provider.baseUrl.endsWith("/") ? provider.baseUrl : `${provider.baseUrl}/`;
    const r = await fetch(new URL("models", base).href, {
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const { data } = await r.json();
    const ids = (data ?? []).map((m) => m.id).filter(Boolean);
    if (!ids.length) return null;
    if (!ids.includes(settings.defaultModel)) {
      settings.defaultModel = ids[0];
    }
    // 三处必须一致：defaultModel、provider.models[].id（getModel 查这里）、
    // enabledModels（scope 收窄到被测模型，杜绝落到别的 provider 再超时）
    provider.models = [{ ...(provider.models?.[0] ?? {}), id: settings.defaultModel }];
    settings.enabledModels = [`${settings.defaultProvider}/${settings.defaultModel}`];
  } catch { return null; }

  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
  writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(models, null, 2));
  for (const f of ["auth.json", "mcp.json"]) {
    const src = path.join(real, f);
    if (existsSync(src)) copyFileSync(src, path.join(agentDir, f));
  }
  return { agentDir, model: `${settings.defaultProvider}/${settings.defaultModel}` };
}
