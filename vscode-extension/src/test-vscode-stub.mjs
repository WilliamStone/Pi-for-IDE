// Minimal `vscode` module stub for node --test runs (registerHooks in
// bridge.test.mjs redirects the specifier here). Adapts the surfaces Bridge
// uses to Node equivalents; editor/command APIs record calls so tests can
// assert on them.
import * as fsp from "node:fs/promises";

export const calls = { executeCommand: [], showTextDocument: [], openTextDocument: [], appliedEdits: [], messages: [] };

export const Uri = {
  file: (p) => ({
    scheme: "file",
    fsPath: p,
    path: p,
    with: (change) => ({ scheme: change.scheme ?? "file", fsPath: p, path: p, toString: () => `${change.scheme ?? "file"}://${p}` }),
    toString: () => `file://${p}`,
  }),
  parse: (s) => ({ scheme: s.split(":")[0], toString: () => s }),
};

export class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}
export class WorkspaceEdit {
  constructor() { this.ops = []; }
  insert(uri, pos, text) { this.ops.push({ kind: "insert", uri, pos, text }); }
}
export class Selection {
  constructor(anchor, active) {
    this.anchor = anchor;
    this.active = active ?? anchor;
  }
}

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
  openTextDocument: async (arg = {}) => {
    // Uri 入参（含 untitled 路径绑定）→ 带 uri 的 doc；{content,language}
    // 选项 → 纯文本 doc。记录入参供"延迟写入"类断言。
    if (arg && arg.fsPath !== undefined) {
      calls.openTextDocument.push(arg);
      return { uri: arg };
    }
    const { content, language } = arg;
    return { getText: () => content, language };
  },
  findFiles: async () => [],
  applyEdit: async (we) => {
    calls.appliedEdits.push(we);
    return true;
  },
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
  // 补一枚 tab 进首个组并发 opened 事件——镜像 close，供"晚到 tab
  // 重扫补注册"的用例驱动枚举。
  open: (tab) => {
    (tabGroups.all[0] ??= { tabs: [] }).tabs.push(tab);
    for (const cb of tabEventListeners) cb({ closed: [], opened: [tab], changed: [] });
  },
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
    // 返回值兼作 TextEditor：无 edit 的 doc（如 URI 打开的）补一个记录
    // 插入文本的 edit——测试据此断言 untitled 骨架被注入。
    if (doc && typeof doc === "object" && !doc.edit) {
      doc.__inserted = "";
      doc.edit = async (fn) => {
        fn({ insert: (_pos, text) => { doc.__inserted += text; } });
        return true;
      };
    }
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
