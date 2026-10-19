import { exec } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { baseName, isWithinCwd, normalizeAbsPath, pathKey, toGitRelPath } from "./paths";
import { applyEditsReversed } from "./revert";

// ---------------------------------------------------------------------
// 活动编辑器缓存：用户切到 pi-web 面板时编辑器会失焦（activeTextEditor
// 变为 undefined），但用户正在看的那个文件标签仍展示着。缓存最后一次
// 有效的活动编辑器，失焦时继续返回它，保证隐藏 system prompt 注入与
// 输入框提示不因焦点切换而丢失。
// ---------------------------------------------------------------------
let lastActiveEditor: { relativePath: string; filePath: string } | null = null;

/** 解析当前活动编辑器；失焦时返回最后一次有效的缓存。 */
export function resolveActiveEditor(): { relativePath: string; filePath: string } | null {
  const editor = vscode.window.activeTextEditor;
  const doc = editor?.document;
  if (!doc || doc.uri.scheme !== "file") {
    return lastActiveEditor;
  }
  const filePath = doc.uri.fsPath;
  const ws = vscode.workspace.getWorkspaceFolder(doc.uri);
  const relativePath = ws
    ? vscode.workspace.asRelativePath(doc.uri, false)
    : filePath;
  lastActiveEditor = { relativePath, filePath };
  return lastActiveEditor;
}

/** 文件被关闭时清除对应缓存（避免已关闭的文件仍被算作当前文件）。 */
export function clearActiveEditorCache(filePath: string): void {
  if (lastActiveEditor?.filePath === filePath) {
    lastActiveEditor = null;
  }
}

/**
 * Bridges requests that originate from the pi-web page (via the webview)
 * to VSCode APIs, then returns responses back to the page.
 *
 * Request shapes (mirror lib/embed/bridge.ts in the pi-web app):
 *   openFile    → reveal / open a file in the editor
 *   completeAt  → file-name completion for the chat @-menu
 *   readFile    → read a file's text contents (used sparingly)
 *   notify      → informational message (status / warning / error)
 */
export class Bridge {
  constructor(private readonly logger: (line: string) => void) {}

  /**
   * 处理单个请求并返回其负载（作为同样 id 的 source:"host" 消息发回页面）。
   */
  async handle(request: BridgeRequest): Promise<unknown> {
    switch (request.kind) {
      case "openFile":
        await this.openFile(request);
        return {};
      case "completeAt":
        return await this.completeAt(request);
      case "readFile":
        return await this.readFile(request);
      case "notify":
        this.notify(request);
        return {};
      case "clipboardRead":
        return await this.clipboardRead();
      case "clipboardWrite":
        await this.clipboardWrite(request);
        return {};
      case "openInBrowser":
        await this.openInBrowser(request);
        return {};
      case "getActiveEditor":
        return await this.getActiveEditor();
      case "captureSnapshot":
        return await this.captureSnapshot(request);
      case "getBeforeContent":
        return await this.getBeforeContent(request);
      case "reconstructBefore":
        return await this.reconstructBefore(request);
      case "showDiff":
        await this.showDiff(request);
        return {};
      case "revertFiles":
        return await this.revertFiles(request);
      case "revertEdit":
        return await this.revertEdit(request);
      case "getCapabilities":
        return { kind: "getCapabilities", capabilities: HOST_CAPABILITIES };
      default:
        return {};
    }
  }

  private async openFile(req: OpenFileRequest): Promise<void> {
    const uri = vscode.Uri.file(req.filePath);
    const canPreview = req.mode !== "diff";
    try {
      await vscode.commands.executeCommand("vscode.open", uri, {
        preview: canPreview,
      });
    } catch (error) {
      this.logger(`openFile failed: ${error}`);
    }
  }

  async completeAt(req: CompleteAtRequest): Promise<CompleteAtResponse> {
    const workspace = vscode.workspace.workspaceFolders ?? [];
    let files: string[] = [];

    const cwd = req.cwd;
    // Find the workspace folder that matches the requested cwd. If the cwd is
    // outside any workspace, fall back to the first workspace folder.
    // 边界匹配：`C:\proj` 不得命中 folder `C:\pro`。
    const normCwd = cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const targetFolder = workspace.find((f) => {
      const root = f.uri.fsPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      return normCwd === root || normCwd.startsWith(root + "/");
    }) ?? workspace[0];

    this.logger(
      `completeAt: cwd=${cwd}, query=${JSON.stringify(req.query)}, ` +
        `workspaceFolders=${workspace.map((f) => f.uri.fsPath).join("; ") || "(none)"}, ` +
        `targetFolder=${targetFolder?.uri.fsPath ?? "(none)"}`,
    );

    if (targetFolder) {
      files = await listFilesInFolder(targetFolder, req.query, this.logger);
    } else if (cwd) {
      files = await listFilesInPath(cwd, req.query, this.logger);
    }

    this.logger(`completeAt: ${files.length} files`);

    // Cap the response size — the page's @-menu renders all results.
    const cap = 50;
    const matches = files.slice(0, cap).map((p) => ({
      path: p,
      isDir: false,
    }));

    return { kind: "completeAt", matches };
  }

  private async readFile(req: ReadFileRequest): Promise<ReadFileResponse> {
    try {
      const uri = vscode.Uri.file(req.filePath);
      const bytes = await vscode.workspace.fs.readFile(uri);
      return { kind: "readFile", content: Buffer.from(bytes).toString("utf8") };
    } catch (error) {
      return { kind: "readFile", error: String(error) };
    }
  }

  private notify(req: NotifyRequest): void {
    if (req.level === "error") {
      void vscode.window.showErrorMessage(req.message);
    } else if (req.level === "warning") {
      void vscode.window.showWarningMessage(req.message);
    } else {
      void vscode.window.showInformationMessage(req.message);
    }
  }

  private async openInBrowser(req: OpenInBrowserRequest): Promise<void> {
    // 只允许打开本机服务器地址（127.0.0.1 / localhost），避免被页面诱导
    // 打开任意外部 URL。
    try {
      const parsed = new URL(req.url);
      const host = parsed.hostname;
      if (host !== "127.0.0.1" && host !== "localhost") {
        this.logger(`openInBrowser rejected non-local host: ${host}`);
        return;
      }
      const origin = parsed.origin;
      this.logger(`openInBrowser: opening ${origin}`);
      await vscode.env.openExternal(vscode.Uri.parse(origin));
    } catch (error) {
      this.logger(`openInBrowser failed: ${error}`);
    }
  }

  private async clipboardRead(): Promise<ClipboardReadResponse> {
    // vscode.env.clipboard 是系统剪贴板，跟编辑器「复制/粘贴」命令走的是同一份
    // 数据，不受 webview 跨源 iframe 的权限策略限制。
    const text = await vscode.env.clipboard.readText();
    return { kind: "clipboardRead", text };
  }

  private async clipboardWrite(req: ClipboardWriteRequest): Promise<void> {
    await vscode.env.clipboard.writeText(req.text);
  }

  private async getActiveEditor(): Promise<GetActiveEditorResponse> {
    const active = resolveActiveEditor();
    return {
      kind: "getActiveEditor",
      relativePath: active?.relativePath ?? null,
      filePath: active?.filePath ?? null,
    };
  }

  // ---------------------------------------------------------------------
  // 文件快照 + diff + 回退（零 git 写入：不创建任何 git 对象/refs）
  // ---------------------------------------------------------------------

  /**
   * session cwd → 最近3轮快照的内存表。快照只存「本轮前相对 HEAD 有
   * 未提交改动的文件」的磁盘内容 + git 是否可用。超出3轮自动淘汰最老。
   */
  private readonly snapshots = new Map<string, TurnSnapshot[]>();
  private static readonly MAX_TURNS = 3;

  /**
   * 在新一轮 prompt 发出前建快照。只读：git diff HEAD --name-only 取
   * 「相对 HEAD 有改动的文件」清单 + 读这些文件的磁盘内容。不创建
   * 任何 git 对象，不动 index/stash list。
   */
  private async captureSnapshot(req: CaptureSnapshotRequest): Promise<CaptureSnapshotResponse> {
    const { turnId, cwd } = req;
    try {
      // 1. git 仓库根——diff/ls-files/show 的路径都相对 toplevel，cwd 在
      //    子目录时按 cwd 拼会全错位；非仓库则 gitRoot=null。
      const gitRoot = await this.gitToplevel(cwd);
      // 2. 取相对 HEAD 有改动的文件清单（只读，repo-root 相对）
      let dirtyFiles: string[] = [];
      if (gitRoot) {
        dirtyFiles = await this.gitDiffNameOnly(gitRoot);
      }
      // 3. 读这些文件的磁盘内容（本轮前的未提交改动）。单文件 >2MB 跳过
      // （快照留空，回退走 HEAD 兜底）——脏区巨大的仓库不该全量读进内存。
      //    键用 pathKey：win32 下各来源的大小写不一致会让字符串键假 miss。
      const files = new Map<string, string>();
      for (const p of dirtyFiles) {
        const abs = this.normalizePath(p, gitRoot ?? cwd);
        const content = await this.readFileText(abs, 2 * 1024 * 1024);
        if (content !== null) files.set(pathKey(abs, cwd), content);
      }
      // 4. 存内存表，超出3轮淘汰最老
      let list = this.snapshots.get(cwd);
      if (!list) { list = []; this.snapshots.set(cwd, list); }
      list.push({ turnId, gitRoot, files });
      while (list.length > Bridge.MAX_TURNS) list.shift();
      this.logger(`captureSnapshot: turn=${turnId}, git=${!!gitRoot}, dirtyFiles=${dirtyFiles.length}`);
      return { kind: "captureSnapshot", success: true };
    } catch (error) {
      this.logger(`captureSnapshot failed: ${error}`);
      return { kind: "captureSnapshot", success: false, message: String(error) };
    }
  }

  /**
   * 取某文件在本轮快照里的 before 内容。优先级：
   *   1. 快照里有 → 返回快照内容（含本轮前未提交改动）
   *   2. git 仓库且文件被追踪 → git show HEAD:path（= HEAD 版本）
   *   3. 都没有 → null（前端据此标「无快照」）
   */
  private async getBeforeContent(req: GetBeforeContentRequest): Promise<GetBeforeContentResponse> {
    const { turnId, filePath, cwd } = req;
    try {
      const list = this.snapshots.get(cwd);
      const snap = list?.find((s) => s.turnId === turnId);
      if (snap) {
        const abs = this.normalizePath(filePath, cwd);
        const key = pathKey(abs, cwd);
        if (snap.files.has(key)) {
          return { kind: "getBeforeContent", content: snap.files.get(key)! };
        }
        // 快照无此文件且 git 可用 → 试 git show HEAD:<repo-rel>
        if (snap.gitRoot) {
          const rel = toGitRelPath(abs, snap.gitRoot);
          const content = await this.gitShowHead(snap.gitRoot, rel);
          return { kind: "getBeforeContent", content };
        }
      }
      return { kind: "getBeforeContent", content: null };
    } catch (error) {
      this.logger(`getBeforeContent failed: ${error}`);
      return { kind: "getBeforeContent", content: null };
    }
  }

  /**
   * 反放重建 before：读磁盘当前内容，把该轮的 edits 反序换回 oldText——
   * 不依赖快照/git，任意历史轮（旧版会话、快照淘汰后）都能给出 diff 左侧。
   * 与 revertEdit 同一校验：文件后来被外部改动（newText 失踪/多现）→ null。
   */
  private async reconstructBefore(req: ReconstructBeforeRequest): Promise<ReconstructBeforeResponse> {
    const { filePath, cwd, edits } = req;
    try {
      const abs = this.normalizePath(filePath, cwd);
      if (!isWithinCwd(abs, cwd) || !edits?.length) {
        return { kind: "reconstructBefore", content: null };
      }
      const current = await this.readFileText(abs);
      if (current === null) {
        return { kind: "reconstructBefore", content: null };
      }
      const applied = applyEditsReversed(current, edits);
      if (!applied.ok) {
        this.logger(`reconstructBefore: ${filePath} — ${applied.reason}`);
        return { kind: "reconstructBefore", content: null };
      }
      return { kind: "reconstructBefore", content: applied.content };
    } catch (error) {
      this.logger(`reconstructBefore failed: ${error}`);
      return { kind: "reconstructBefore", content: null };
    }
  }

  /**
   * 用 VSCode 原生 diff 显示 before/after。写到临时目录（不进 git），
   * 用 vscode.diff 命令打开侧边对比。before/after 为空时用空内容。
   */
  private async showDiff(req: ShowDiffRequest): Promise<void> {
    const { filePath, before, after, title } = req;
    try {
      const base = baseName(filePath);
      const tmpDir = await this.ensureDiffCacheDir();
      // 文名加 hash 后缀避免并发冲突
      const tag = Buffer.from(filePath).toString("hex").slice(0, 12);
      const beforeUri = vscode.Uri.file(`${tmpDir}/${base}.${tag}.before`);
      const afterUri = vscode.Uri.file(`${tmpDir}/${base}.${tag}.after`);
      await vscode.workspace.fs.writeFile(beforeUri, Buffer.from(before, "utf8"));
      await vscode.workspace.fs.writeFile(afterUri, Buffer.from(after, "utf8"));
      const label = title || `${base} (this turn)`;
      await vscode.commands.executeCommand("vscode.diff", beforeUri, afterUri, label);
    } catch (error) {
      this.logger(`showDiff failed: ${error}`);
    }
  }

  /**
   * 回退：把指定文件恢复到本轮快照的内容。直接 fs.writeFile，不碰 git
   * index/对象库。created 里列出的文件（页面声称本轮 write 新建）在快照
   * 与 HEAD 都没有时删除——快照漏采与"本来就存在"已被二者共同排除。
   */
  private async revertFiles(req: RevertFilesRequest): Promise<RevertFilesResponse> {
    const { turnId, files, cwd, created } = req;
    try {
      const list = this.snapshots.get(cwd);
      const snap = list?.find((s) => s.turnId === turnId);
      if (!snap) {
        return { kind: "revertFiles", success: false, message: "snapshot missing or expired" };
      }
      const createdSet = new Set((created ?? []).map((p) => pathKey(p, cwd)));
      let reverted = 0;
      const errors: string[] = [];
      for (const filePath of files) {
        const abs = this.normalizePath(filePath, cwd);
        const key = pathKey(abs, cwd);
        try {
          if (!isWithinCwd(abs, cwd)) {
            errors.push(`${filePath}: outside session cwd`);
            continue;
          }
          if (snap.files.has(key)) {
            // 本轮前有未提交改动 → 恢复成那个内容
            await vscode.workspace.fs.writeFile(
              vscode.Uri.file(abs),
              Buffer.from(snap.files.get(key)!, "utf8"),
            );
            reverted++;
          } else if (snap.gitRoot) {
            // 快照无此文件。可能：本轮前已存在但快照采集遗漏（路径不匹配 /
            // gitDiffNameOnly 未列出），或本轮新建。
            // 用 git show HEAD:<repo-rel> 兴许能取到本轮前内容（= HEAD 版本）。
            const rel = toGitRelPath(abs, snap.gitRoot);
            const content = await this.gitShowHead(snap.gitRoot, rel);
            if (content !== null) {
              // git HEAD 有此文件 → 恢复成 HEAD 版本
              await vscode.workspace.fs.writeFile(
                vscode.Uri.file(abs),
                Buffer.from(content, "utf8"),
              );
              reverted++;
            } else if (createdSet.has(key)) {
              // 快照没有 + HEAD 没有 + 页面记录为本轮新建 → 删除即回退。
              // 快照采集过的"已存在文件"进不了这个分支（dirty 清单含
              // 未追踪文件，存在即入快照），误删空间只剩页面假报。
              await vscode.workspace.fs.delete(vscode.Uri.file(abs));
              reverted++;
            } else {
              // git HEAD 无此文件且页面未声明本轮新建（本轮前就不在 git 里）。
              // 不安全地删文件会误删——可能只是快照采集遗漏。宁可报错，也不删。
              errors.push(`${filePath}: no snapshot and file absent from git HEAD; cannot revert safely`);
            }
          } else if (createdSet.has(key)) {
            // 非 git：快照无 + 页面声明本轮新建 → 删。
            await vscode.workspace.fs.delete(vscode.Uri.file(abs));
            reverted++;
          } else {
            // 非 git 且快照无 → 无法回退
            errors.push(`${filePath}: no snapshot and not a git repo`);
          }
        } catch (error) {
          errors.push(`${filePath}: ${error}`);
        }
      }
      this.logger(`revertFiles: turn=${turnId}, reverted=${reverted}/${files.length}`);
      return {
        kind: "revertFiles",
        success: errors.length === 0,
        message: errors.length ? errors.join("; ") : undefined,
      };
    } catch (error) {
      this.logger(`revertFiles failed: ${error}`);
      return { kind: "revertFiles", success: false, message: String(error) };
    }
  }

  /**
   * 回退 edit：读磁盘当前内容，把每个 newText 换回 oldText（反序 apply）。
   * 纯 fs，零 git。edit 工具的 input.edits 自带 oldText/newText 对，
   * 反序遍历（后改的先换回）依次 replace 即可还原。
   */
  private async revertEdit(req: RevertEditRequest): Promise<RevertEditResponse> {
    const { filePath, cwd, edits } = req;
    try {
      const abs = this.normalizePath(filePath, cwd);
      if (!isWithinCwd(abs, cwd)) {
        return {
          kind: "revertEdit",
          success: false,
          message: `path outside session cwd: ${filePath}`,
        };
      }
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
      const content = Buffer.from(bytes).toString("utf8");
      // 反序 apply：后改的先换回，避免前面的 replace 污染后面的上下文
      // （次数校验与 $ 模式防护在纯模块 revert.ts 里）
      const applied = applyEditsReversed(content, edits);
      if (!applied.ok) {
        return { kind: "revertEdit", success: false, message: applied.reason };
      }
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(abs),
        Buffer.from(applied.content, "utf8"),
      );
      this.logger(`revertEdit: ${filePath}, reverse-applying ${edits.length} edits`);
      return { kind: "revertEdit", success: true };
    } catch (error) {
      this.logger(`revertEdit failed: ${error}`);
      return { kind: "revertEdit", success: false, message: String(error) };
    }
  }

  // --- git / fs 辅助（均只读） ---

  /**
   * git 仓库根的规范化绝对路径；非仓库返回 null。
   * diff/ls-files/show 的路径语义全部相对 toplevel——调用方一律拿这个
   * 根，不能拿 session cwd 拼 git 相对路径。
   */
  private async gitToplevel(cwd: string): Promise<string | null> {
    try {
      const { stdout, exitCode } = await this.runGit(cwd, ["rev-parse", "--show-toplevel"]);
      const top = stdout.trim();
      return exitCode === 0 && top ? this.normalizePath(top, cwd) : null;
    } catch {
      return null;
    }
  }

  private async gitDiffNameOnly(cwd: string): Promise<string[]> {
    // 已追踪文件相对 HEAD 的改动（含已暂存和未暂存的修改/删除）。
    // 注意：git diff HEAD 不含未追踪的新文件，单独用 ls-files 补上。
    const dirty = new Set<string>();
    const { stdout: diffOut, exitCode: diffCode } = await this.runGit(cwd, [
      "diff", "--no-color", "--name-only", "HEAD",
    ]);
    if (diffCode === 0) {
      for (const line of diffOut.split(/\r?\n/)) {
        const s = line.trim();
        if (s) dirty.add(s);
      }
    }
    // 未追踪文件（不含 .gitignore 忽略的）。
    const { stdout: othersOut, exitCode: othersCode } = await this.runGit(cwd, [
      "ls-files", "--others", "--exclude-standard",
    ]);
    if (othersCode === 0) {
      for (const line of othersOut.split(/\r?\n/)) {
        const s = line.trim();
        if (s) dirty.add(s);
      }
    }
    return Array.from(dirty);
  }

  /** git show HEAD:<rel> 取某文件在 HEAD 时的内容。文件不存在返回 null。 */
  private async gitShowHead(cwd: string, relPath: string): Promise<string | null> {
    try {
      const { stdout, exitCode } = await this.runGit(cwd, ["show", `HEAD:${relPath}`]);
      if (exitCode !== 0) return null;
      return stdout;
    } catch {
      return null;
    }
  }

  /** 运行 git 子进程（仅读操作）。 */
  private runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      exec(
        `git ${args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ")}`,
        { cwd, maxBuffer: 20 * 1024 * 1024 },
        (err, stdout, stderr) => {
          resolve({
            stdout: typeof stdout === "string" ? stdout : "",
            stderr: typeof stderr === "string" ? stderr : "",
            exitCode: err ? (err as { code?: number }).code ?? 1 : 0,
          });
        },
      );
    });
  }

  /** 读文件文本，不存在或超过 maxBytes 返回 null。 */
  private async readFileText(absPath: string, maxBytes?: number): Promise<string | null> {
    try {
      if (maxBytes !== undefined) {
        const st = await vscode.workspace.fs.stat(vscode.Uri.file(absPath));
        if (st.size > maxBytes) return null;
      }
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
      return Buffer.from(bytes).toString("utf8");
    } catch {
      return null;
    }
  }

  /** 统一路径规范化入口：跨平台绝对/相对/混合分隔符 → 正斜杠绝对路径。 */
  private normalizePath(p: string, cwd: string): string {
    return normalizeAbsPath(p, cwd);
  }

  private diffCacheDir: string | undefined;
  private async ensureDiffCacheDir(): Promise<string> {
    if (this.diffCacheDir) return this.diffCacheDir;
    const dir = path.join(os.tmpdir(), "pi-web-diff-cache");
    await fs.promises.mkdir(dir, { recursive: true });
    this.diffCacheDir = dir;
    return dir;
  }
}

async function listFilesInFolder(
  folder: vscode.WorkspaceFolder,
  query: string,
  logger: (line: string) => void,
): Promise<string[]> {
  const filePattern = query ? `**/*${query}*` : "**/*";
  // 用 RelativePattern 锁定到目标 folder。若用裸 string glob,在多根工作区
  // 下 findFiles 会搜遍所有 workspace folder(包括无关的、体量巨大的),
  // 既慢又可能让 asRelativePath 返回带错前缀的路径。
  const include = new vscode.RelativePattern(folder, filePattern);
  const excludes = new Set([
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    "out",
    ".cache",
    "coverage",
  ]);
  const excludeGlob = `{${[...excludes].join(",")}}/**`;
  const exclude = new vscode.RelativePattern(folder, excludeGlob);
  try {
    const uris = await vscode.workspace.findFiles(include, exclude, 100);
    // includeWorkspace=false: 多根工作区下也不带 folder 名前缀,返回相对
    // folder 根的路径(cwd 精确等于 folder 时即相对 cwd)。
    return uris.map((u) => vscode.workspace.asRelativePath(u, false));
  } catch (error) {
    logger(
      `listFilesInFolder failed (folder=${folder.uri.fsPath}, ` +
        `query=${JSON.stringify(query)}): ${error}`,
    );
    return [];
  }
}

async function listFilesInPath(
  cwd: string,
  query: string,
  logger: (line: string) => void,
): Promise<string[]> {
  // No workspace — search by reading the directory directly. Used when the
  // user opened a pi-web session whose cwd is outside any workspace folder.
  const folderUri = vscode.Uri.file(cwd);
  const pattern = query ? `*${query}*` : "*";
  try {
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folderUri, pattern),
      undefined,
      100,
    );
    // 文件不在任何 workspace folder 内,返回绝对路径。
    return uris.map((u) => u.fsPath);
  } catch (error) {
    logger(
      `listFilesInPath failed (cwd=${cwd}, query=${JSON.stringify(query)}): ${error}`,
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Request/response types — kept in lockstep with lib/embed/bridge.ts in the
// pi-web app.
// ---------------------------------------------------------------------------

interface OpenFileRequest {
  kind: "openFile";
  filePath: string;
  line?: number;
  column?: number;
  mode?: "source" | "preview" | "diff";
}

interface CompleteAtRequest {
  kind: "completeAt";
  cwd: string;
  query: string;
}

interface ReadFileRequest {
  kind: "readFile";
  filePath: string;
}

interface NotifyRequest {
  kind: "notify";
  message: string;
  level: "info" | "warning" | "error";
}

/** 扩展宿 → pi-web 页面的「提及」推送：由右键菜单触发。 */
interface MentionRequest {
  kind: "mention";
  relativePath: string;
  startLine?: number;
  endLine?: number;
  selectedText?: string;
}

type BridgeRequest =
  | OpenFileRequest
  | CompleteAtRequest
  | ReadFileRequest
  | NotifyRequest
  | MentionRequest
  | ClipboardReadRequest
  | ClipboardWriteRequest
  | GetActiveEditorRequest
  | CaptureSnapshotRequest
  | GetBeforeContentRequest
  | ReconstructBeforeRequest
  | ShowDiffRequest
  | RevertFilesRequest
  | RevertEditRequest
  | OpenInBrowserRequest
  | GetCapabilitiesRequest;

/**
 * 本宿主实现的能力清单：桥请求 kind + 宿主可推送的通知 kind
 * （mention / activeEditorChanged）。页面据此按能力降级；
 * 缺省该接口的旧版宿主被页面视为全量支持。
 */
const HOST_CAPABILITIES = [
  "openFile",
  "completeAt",
  "readFile",
  "notify",
  "clipboardRead",
  "clipboardWrite",
  "openInBrowser",
  "getActiveEditor",
  "captureSnapshot",
  "getBeforeContent",
  "reconstructBefore",
  "showDiff",
  "revertFiles",
  "revertEdit",
  "mention",
  "activeEditorChanged",
] as const;

interface GetCapabilitiesRequest {
  kind: "getCapabilities";
}

interface CompleteAtResponse {
  kind: "completeAt";
  matches: Array<{ path: string; isDir: boolean }>;
}

interface ReadFileResponse {
  kind: "readFile";
  content?: string;
  error?: string;
}

interface ClipboardReadResponse {
  kind: "clipboardRead";
  text: string;
}

interface ClipboardReadRequest {
  kind: "clipboardRead";
}

interface ClipboardWriteRequest {
  kind: "clipboardWrite";
  text: string;
}

interface OpenInBrowserRequest {
  kind: "openInBrowser";
  url: string;
}

interface GetActiveEditorRequest {
  kind: "getActiveEditor";
}

interface GetActiveEditorResponse {
  kind: "getActiveEditor";
  relativePath: string | null;
  filePath: string | null;
}

interface CaptureSnapshotRequest {
  kind: "captureSnapshot";
  turnId: string;
  cwd: string;
}

interface GetBeforeContentRequest {
  kind: "getBeforeContent";
  turnId: string;
  filePath: string;
  cwd: string;
}

interface ReconstructBeforeRequest {
  kind: "reconstructBefore";
  filePath: string;
  cwd: string;
  edits: { oldText: string; newText: string }[];
}

interface ShowDiffRequest {
  kind: "showDiff";
  filePath: string;
  before: string;
  after: string;
  title?: string;
}

interface RevertFilesRequest {
  kind: "revertFiles";
  turnId: string;
  files: string[];
  /** 页面声称本轮新建的文件（快照与 HEAD 都查无时允许删除回退）。 */
  created?: string[];
  cwd: string;
}

interface CaptureSnapshotResponse {
  kind: "captureSnapshot";
  success: boolean;
  message?: string;
}

interface GetBeforeContentResponse {
  kind: "getBeforeContent";
  content: string | null;
}

interface ReconstructBeforeResponse {
  kind: "reconstructBefore";
  content: string | null;
}

interface RevertFilesResponse {
  kind: "revertFiles";
  success: boolean;
  message?: string;
}

interface RevertEditRequest {
  kind: "revertEdit";
  filePath: string;
  cwd: string;
  edits: { oldText: string; newText: string }[];
}

interface RevertEditResponse {
  kind: "revertEdit";
  success: boolean;
  message?: string;
}

/** 单轮快照。files 仅存「相对 HEAD 有未提交改动」的文件内容。 */
interface TurnSnapshot {
  turnId: string;
  /** git 仓库根的规范化绝对路径；非仓库为 null（快照键与 git show 都以此为准）。 */
  gitRoot: string | null;
  /** pathKey → 本轮前磁盘内容。 */
  files: Map<string, string>;
}
