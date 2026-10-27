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

// 类继承面：模块求值就要（extends vscode.Disposable），实例语义用不到。
export class Disposable {
  constructor(fn) { this._fn = fn; }
  dispose() { this._fn?.(); }
}

// 事件面：EventEmitter.event 是可订阅函数，fire 广播。
export class EventEmitter {
  constructor() { this._ls = new Set(); this.event = (cb) => { this._ls.add(cb); return { dispose: () => this._ls.delete(cb) }; }; }
  fire(v) { for (const cb of this._ls) cb(v); }
  dispose() { this._ls.clear(); }
}

export class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export class ThemeIcon {
  constructor(id, color) { this.id = id; this.color = color; }
}
export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 };

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

// 面板复活测试面：TabInputWebview 仅需 instanceof + viewType；
// tabGroups 供 panel-revival 枚举/关闭/变更事件，serializers 记录注册。
export class TabInputWebview {
  constructor(viewType) {
    this.viewType = viewType;
  }
}

export const calls2 = {
  serializers: new Map(), // viewType -> serializer
  closedTabs: [],
};

const tabEventListeners = new Set();
export const tabGroups = {
  all: [],
  close: async (tab) => {
    calls2.closedTabs.push(tab);
    for (const g of tabGroups.all) {
      const i = g.tabs.indexOf(tab);
      if (i >= 0) {
        g.tabs.splice(i, 1);
        for (const cb of tabEventListeners) cb({ closed: [tab], opened: [], changed: [] });
        return true;
      }
    }
    return false;
  },
  onDidChangeTabs: (cb) => {
    tabEventListeners.add(cb);
    return { dispose: () => tabEventListeners.delete(cb) };
  },
};

export const window = {
  activeTextEditor: undefined,
  createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
  createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
  createTreeView: () => ({ dispose() {}, onDidChangeVisibility: () => ({ dispose() {} }), visible: false }),
  onDidChangeActiveTextEditor: () => ({ dispose() {} }),
  showErrorMessage: notify("error"),
  showWarningMessage: notify("warning"),
  showInformationMessage: notify("info"),
  showTextDocument: async (doc, opts) => {
    calls.showTextDocument.push({ doc, opts });
    return doc;
  },
  tabGroups,
  registerWebviewPanelSerializer: (viewType, serializer) => {
    calls2.serializers.set(viewType, serializer);
    return { dispose: () => calls2.serializers.delete(viewType) };
  },
};

export const env = {
  openExternal: async () => true,
  clipboard: {
    readText: async () => "",
    writeText: async () => {},
  },
};
