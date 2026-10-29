import * as vscode from "vscode";
import { TurnRevert } from "./bridge-revert";
import type {
  CaptureSnapshotRequest,
  GetBeforeContentRequest,
  OpenTextRequest,
  ReconstructBeforeRequest,
  RevertEditRequest,
  RevertFilesRequest,
  ShowDiffRequest,
} from "./bridge-revert";

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
  private readonly logger: (line: string) => void;
  /** 快照/diff/回退域（独立状态：快照表 + diff 缓存目录）——bridge-revert.ts。 */
  private readonly revertOps: TurnRevert;
  constructor(logger: (line: string) => void) {
    this.logger = logger;
    this.revertOps = new TurnRevert(logger);
  }

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
        return await this.revertOps.captureSnapshot(request);
      case "getBeforeContent":
        return await this.revertOps.getBeforeContent(request);
      case "reconstructBefore":
        return await this.revertOps.reconstructBefore(request);
      case "showDiff":
        await this.revertOps.showDiff(request);
        return {};
      case "openText":
        await this.revertOps.openText(request);
        return {};
      case "revertFiles":
        return await this.revertOps.revertFiles(request);
      case "revertEdit":
        return await this.revertOps.revertEdit(request);
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
  | OpenTextRequest
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
  "openText",
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

