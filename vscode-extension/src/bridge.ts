import * as vscode from "vscode";

/**
 * Bridges requests that originate from the pi-web page (via the webview)
 * to VSCode APIs, then returns responses back to the page.
 *
 * Request shapes (mirror lib/vscode-bridge.ts in the pi-web app):
 *   openFile    → reveal / open a file in the editor
 *   completeAt  → file-name completion for the chat @-menu
 *   readFile    → read a file's text contents (used sparingly)
 *   notify      → informational message (status / warning / error)
 */
export class Bridge {
  constructor(private readonly logger: (line: string) => void) {}

  /**
   * 处理单个请求并返回其负载（作为同样 id 的 source:"vscode" 消息发回页面）。
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
      case "captureSnapshot":
        return await this.captureSnapshot(request);
      case "getBeforeContent":
        return await this.getBeforeContent(request);
      case "showDiff":
        await this.showDiff(request);
        return {};
      case "revertFiles":
        return await this.revertFiles(request);
      case "revertEdit":
        return await this.revertEdit(request);
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
      this.logger(`openFile 失败: ${error}`);
    }
  }

  async completeAt(req: CompleteAtRequest): Promise<CompleteAtResponse> {
    const workspace = vscode.workspace.workspaceFolders ?? [];
    let files: string[] = [];

    const cwd = req.cwd;
    // Find the workspace folder that matches the requested cwd. If the cwd is
    // outside any workspace, fall back to the first workspace folder.
    let targetFolder = workspace.find((f) => cwd.startsWith(f.uri.fsPath)) ?? workspace[0];

    this.logger(
      `completeAt: cwd=${cwd}, query=${JSON.stringify(req.query)}, ` +
        `workspaceFolders=${workspace.map((f) => f.uri.fsPath).join("; ") || "(空)"}, ` +
        `targetFolder=${targetFolder?.uri.fsPath ?? "(无)"}`,
    );

    if (targetFolder) {
      files = await listFilesInFolder(targetFolder, req.query, this.logger);
    } else if (cwd) {
      files = await listFilesInPath(cwd, req.query, this.logger);
    }

    this.logger(`completeAt: 返回 ${files.length} 个文件`);

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

  private async clipboardRead(): Promise<ClipboardReadResponse> {
    // vscode.env.clipboard 是系统剪贴板，跟编辑器「复制/粘贴」命令走的是同一份
    // 数据，不受 webview 跨源 iframe 的权限策略限制。
    const text = await vscode.env.clipboard.readText();
    return { kind: "clipboardRead", text };
  }

  private async clipboardWrite(req: ClipboardWriteRequest): Promise<void> {
    await vscode.env.clipboard.writeText(req.text);
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
      // 1. 检测是否 git 仓库
      const inGit = await this.isInsideGitRepo(cwd);
      // 2. 取相对 HEAD 有改动的文件清单（只读）
      let dirtyFiles: string[] = [];
      if (inGit) {
        dirtyFiles = await this.gitDiffNameOnly(cwd);
      }
      // 3. 读这些文件的磁盘内容（本轮前的未提交改动）
      const files = new Map<string, string>();
      for (const p of dirtyFiles) {
        const abs = this.resolveAbsPath(p, cwd);
        const content = await this.readFileText(abs);
        if (content !== null) files.set(abs, content);
      }
      // 4. 存内存表，超出3轮淘汰最老
      let list = this.snapshots.get(cwd);
      if (!list) { list = []; this.snapshots.set(cwd, list); }
      list.push({ turnId, inGit, files });
      while (list.length > Bridge.MAX_TURNS) list.shift();
      this.logger(`captureSnapshot: turn=${turnId}, git=${inGit}, dirtyFiles=${dirtyFiles.length}`);
      return { kind: "captureSnapshot", success: true };
    } catch (error) {
      this.logger(`captureSnapshot 失败: ${error}`);
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
        const abs = this.resolveAbsPath(filePath, cwd);
        if (snap.files.has(abs)) {
          return { kind: "getBeforeContent", content: snap.files.get(abs)! };
        }
        // 快照无此文件且 git 可用 → 试 git show HEAD:path
        if (snap.inGit) {
          const rel = this.toGitRel(filePath, cwd);
          const content = await this.gitShowHead(cwd, rel);
          return { kind: "getBeforeContent", content };
        }
      }
      return { kind: "getBeforeContent", content: null };
    } catch (error) {
      this.logger(`getBeforeContent 失败: ${error}`);
      return { kind: "getBeforeContent", content: null };
    }
  }

  /**
   * 用 VSCode 原生 diff 显示 before/after。写到临时目录（不进 git），
   * 用 vscode.diff 命令打开侧边对比。before/after 为空时用空内容。
   */
  private async showDiff(req: ShowDiffRequest): Promise<void> {
    const { filePath, before, after, title } = req;
    try {
      const baseName = filePath.split("/").pop() || "file";
      const tmpDir = await this.ensureDiffCacheDir();
      // 文名加 hash 后缀避免并发冲突
      const tag = Buffer.from(filePath).toString("hex").slice(0, 12);
      const beforeUri = vscode.Uri.file(`${tmpDir}/${baseName}.${tag}.before`);
      const afterUri = vscode.Uri.file(`${tmpDir}/${baseName}.${tag}.after`);
      await vscode.workspace.fs.writeFile(beforeUri, Buffer.from(before, "utf8"));
      await vscode.workspace.fs.writeFile(afterUri, Buffer.from(after, "utf8"));
      const label = title || `${baseName} (本轮改动)`;
      await vscode.commands.executeCommand("vscode.diff", beforeUri, afterUri, label);
    } catch (error) {
      this.logger(`showDiff 失败: ${error}`);
    }
  }

  /**
   * 回退：把指定文件恢复到本轮快照的内容。直接 fs.writeFile，不碰 git
   * index/对象库。before 为空（新文件）则 fs.unlink 删掉。
   */
  private async revertFiles(req: RevertFilesRequest): Promise<RevertFilesResponse> {
    const { turnId, files, cwd } = req;
    try {
      const list = this.snapshots.get(cwd);
      const snap = list?.find((s) => s.turnId === turnId);
      if (!snap) {
        return { kind: "revertFiles", success: false, message: "快照不存在或已过期" };
      }
      let reverted = 0;
      const errors: string[] = [];
      for (const filePath of files) {
        const abs = this.resolveAbsPath(filePath, cwd);
        try {
          if (snap.files.has(abs)) {
            // 本轮前有未提交改动 → 恢复成那个内容
            await vscode.workspace.fs.writeFile(
              vscode.Uri.file(abs),
              Buffer.from(snap.files.get(abs)!, "utf8"),
            );
            reverted++;
          } else if (snap.inGit) {
            // 快照无此文件。可能：本轮前已存在但快照采集遗漏（路径不匹配 /
            // gitDiffNameOnly 未列出），或本轮新建。
            // 用 git show HEAD:path 兴许能取到本轮前内容（= HEAD 版本）。
            const rel = this.toGitRel(filePath, cwd);
            const content = await this.gitShowHead(cwd, rel);
            if (content !== null) {
              // git HEAD 有此文件 → 恢复成 HEAD 版本
              await vscode.workspace.fs.writeFile(
                vscode.Uri.file(abs),
                Buffer.from(content, "utf8"),
              );
              reverted++;
            } else {
              // git HEAD 无此文件（本轮前就不在 git 里）。不安全地删文件会
              // 误删——可能只是快照采集遗漏。宁可报错，也不删。
              errors.push(`${filePath}: 无快照且 git HEAD 无此文件，无法安全回退`);
            }
          } else {
            // 非 git 且快照无 → 无法回退
            errors.push(`${filePath}: 无快照且非 git`);
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
      this.logger(`revertFiles 失败: ${error}`);
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
      const abs = this.resolveAbsPath(filePath, cwd);
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
      let content = Buffer.from(bytes).toString("utf8");
      // 反序 apply：后改的先换回，避免前面的 replace 污染后面的上下文
      for (let i = edits.length - 1; i >= 0; i--) {
        const { oldText, newText } = edits[i];
        if (!content.includes(newText)) {
          return {
            kind: "revertEdit",
            success: false,
            message: `第 ${i + 1} 处改动的新内容在文件中找不到，可能文件已被其他方式修改`,
          };
        }
        content = content.replace(newText, oldText);
      }
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(abs),
        Buffer.from(content, "utf8"),
      );
      this.logger(`revertEdit: ${filePath}, 反向 apply ${edits.length} 处`);
      return { kind: "revertEdit", success: true };
    } catch (error) {
      this.logger(`revertEdit 失败: ${error}`);
      return { kind: "revertEdit", success: false, message: String(error) };
    }
  }

  // --- git / fs 辅助（均只读） ---

  private async isInsideGitRepo(cwd: string): Promise<boolean> {
    try {
      const { exitCode } = await this.runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
      return exitCode === 0;
    } catch {
      return false;
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
    const { exec } = require("child_process") as typeof import("child_process");
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

  /** 读文件文本，不存在返回 null。 */
  private async readFileText(absPath: string): Promise<string | null> {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
      return Buffer.from(bytes).toString("utf8");
    } catch {
      return null;
    }
  }

  /** 把路径解析成绝对路径（相对 cwd）。规范掉尾斜杠，保证存/查 key 一致。 */
  private resolveAbsPath(p: string, cwd: string): string {
    if (p.startsWith("/")) return p.replace(/\/+$/, "");
    return `${cwd.replace(/\/+$/, "")}/${p}`;
  }

  /** 把绝对路径转成相对 git 仓库根的路径（用于 git show HEAD:path）。 */
  private toGitRel(absPath: string, cwd: string): string {
    const normCwd = cwd.replace(/\/+$/, "");
    if (absPath.startsWith(normCwd + "/")) {
      return absPath.slice(normCwd.length + 1);
    }
    if (absPath === normCwd) return ".";
    return absPath;
  }

  private diffCacheDir: string | undefined;
  private async ensureDiffCacheDir(): Promise<string> {
    if (this.diffCacheDir) return this.diffCacheDir;
    const os = require("os");
    const path = require("path");
    const dir = path.join(os.tmpdir(), "pi-web-diff-cache");
    const fs = require("fs");
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
      `listFilesInFolder 失败 (folder=${folder.uri.fsPath}, ` +
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
      `listFilesInPath 失败 (cwd=${cwd}, query=${JSON.stringify(query)}): ${error}`,
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Request/response types — kept in lockstep with lib/vscode-bridge.ts in the
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
  | CaptureSnapshotRequest
  | GetBeforeContentRequest
  | ShowDiffRequest
  | RevertFilesRequest
  | RevertEditRequest;

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
  /** 该轮是否在 git 仓库内。 */
  inGit: boolean;
  /** absPath → 本轮前磁盘内容。 */
  files: Map<string, string>;
}
