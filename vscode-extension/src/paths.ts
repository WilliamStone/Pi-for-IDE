import path from "path";

/**
 * 桥接层路径规范化。pi 工具的 input.path、git 输出、session cwd 在 Windows
 * 下会混出 `S:\x`、`S:/x`、相对路径、UNC 几种形态；所有 fs 读写 key、
 * snapshot map、git show 的相对路径推导都先过这里，统一成正斜杠绝对路径。
 * 不依赖 vscode，便于单测。
 */

/** 是否为跨平台绝对路径（盘符 `S:\`/`S:/`、POSIX `/`、UNC `\\`）。 */
export function isAbsolutePath(p: string): boolean {
  return /^([a-zA-Z]:[\\/]|\/|\\\\)/.test(p.trim());
}

/** 把 p 解析成正斜杠绝对路径；相对路径拼到规范化后的 cwd 上，折叠 `.`/`..`。 */
export function normalizeAbsPath(p: string, cwd: string): string {
  const raw = p.trim().replace(/\\/g, "/");
  const base = /^([a-zA-Z]:|\/)/.test(raw)
    ? raw
    : `${cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "")}/${raw}`;
  const out = path.posix.normalize(base).replace(/\/+$/, "");
  return out === "" ? "/" : out;
}

function cmpKey(s: string): string {
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/** map 键形态：规范化绝对路径；win32 再整体小写（git 输出/配置/页面来源的
 *  盘符与目录大小写常不一致，字符串相等会假 miss）。 */
export function pathKey(p: string, cwd: string): string {
  return cmpKey(normalizeAbsPath(p, cwd));
}

/** abs 是否位于 cwd 子树内（含等于 cwd）。用于写类桥接请求的白名单。 */
export function isWithinCwd(absPath: string, cwd: string): boolean {
  const a = cmpKey(normalizeAbsPath(absPath, cwd));
  const root = cmpKey(normalizeAbsPath(cwd, cwd));
  return a === root || a.startsWith(root + "/");
}

/** 绝对路径 → 相对 git 仓库根（cwd）的路径，`git show HEAD:rel` 用。 */
export function toGitRelPath(absPath: string, cwd: string): string {
  const a = normalizeAbsPath(absPath, cwd);
  const root = normalizeAbsPath(cwd, cwd);
  if (cmpKey(a) === cmpKey(root)) return ".";
  if (cmpKey(a).startsWith(cmpKey(root) + "/")) {
    return a.slice(root.length + 1);
  }
  return a;
}

/** 取文件 basename（任意分隔符形态，永不返回含 `:` 的串）。 */
export function baseName(p: string): string {
  const segs = p.trim().replace(/\\/g, "/").split("/").filter(Boolean);
  return segs[segs.length - 1] ?? "file";
}
