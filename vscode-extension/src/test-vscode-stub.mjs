// Minimal `vscode` module stub for node --test runs (registerHooks in
// bridge.test.mjs redirects the specifier here). Adapts the surfaces Bridge
// uses to Node equivalents; editor/command APIs record calls so tests can
// assert on them.
import * as fsp from "node:fs/promises";

export const calls = { executeCommand: [], showTextDocument: [], messages: [] };

export const Uri = {
  file: (p) => ({ scheme: "file", fsPath: p, path: p, toString: () => `file://${p}` }),
  parse: (s) => ({ scheme: s.split(":")[0], toString: () => s }),
};

export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

function toFsType(s) {
  if (s.isSymbolicLink()) return FileType.SymbolicLink;
  if (s.isDirectory()) return FileType.Directory;
  return FileType.File;
}

export const workspace = {
  fs: {
    readFile: (uri) => fsp.readFile(uri.fsPath).then((b) => new Uint8Array(b)),
    writeFile: (uri, bytes) => fsp.writeFile(uri.fsPath, Buffer.from(bytes)),
    stat: async (uri) => {
      const s = await fsp.stat(uri.fsPath);
      return { type: toFsType(s), size: s.size, ctime: s.ctimeMs, mtime: s.mtimeMs };
    },
    delete: (uri) => fsp.rm(uri.fsPath, { force: true, recursive: true }),
  },
  workspaceFolders: [],
  getWorkspaceFolder: () => undefined,
  asRelativePath: (uri) => uri.fsPath,
  openTextDocument: async ({ content, language } = {}) => ({
    getText: () => content,
    language,
  }),
  findFiles: async () => [],
};

export class RelativePattern {
  constructor(base, pattern) {
    this.base = base?.uri?.fsPath ?? base;
    this.pattern = pattern;
  }
}

export const commands = {
  executeCommand: async (cmd, ...args) => {
    calls.executeCommand.push({ cmd, args });
    return undefined;
  },
};

const notify = (level) => async (text) => {
  calls.messages.push({ level, text });
};

export const window = {
  activeTextEditor: undefined,
  showErrorMessage: notify("error"),
  showWarningMessage: notify("warning"),
  showInformationMessage: notify("info"),
  showTextDocument: async (doc, opts) => {
    calls.showTextDocument.push({ doc, opts });
    return doc;
  },
};

export const env = {
  openExternal: async () => true,
  clipboard: {
    readText: async () => "",
    writeText: async () => {},
  },
};
