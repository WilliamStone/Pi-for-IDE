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

  private async completeAt(req: CompleteAtRequest): Promise<CompleteAtResponse> {
    const workspace = vscode.workspace.workspaceFolders ?? [];
    let files: string[] = [];

    const cwd = req.cwd;
    // Find the workspace folder that matches the requested cwd. If the cwd is
    // outside any workspace, fall back to the first workspace folder.
    let targetFolder = workspace.find((f) => cwd.startsWith(f.uri.fsPath)) ?? workspace[0];

    if (targetFolder) {
      files = await listFilesInFolder(targetFolder, req.query);
    } else if (cwd) {
      files = await listFilesInPath(cwd, req.query);
    }

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
}

async function listFilesInFolder(folder: vscode.WorkspaceFolder, query: string): Promise<string[]> {
  const pattern = query ? `**/*${query}*` : "**/*";
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

  try {
    const uris = await vscode.workspace.findFiles(
      pattern,
      `{${[...excludes].map((e) => e).join(",")}}/**`,
      100,
    );
    return uris.map((u) => vscode.workspace.asRelativePath(u));
  } catch {
    return [];
  }
}

async function listFilesInPath(cwd: string, query: string): Promise<string[]> {
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
    return uris.map((u) => u.fsPath);
  } catch {
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
  | MentionRequest;

interface CompleteAtResponse {
  kind: "completeAt";
  matches: Array<{ path: string; isDir: boolean }>;
}

interface ReadFileResponse {
  kind: "readFile";
  content?: string;
  error?: string;
}
