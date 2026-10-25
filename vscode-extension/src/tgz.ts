import {
  mkdirSync,
  promises as fsp,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import * as path from "path";
import { gunzipSync, gunzip } from "zlib";
import { promisify } from "util";
import { compareVersions } from "./version";

const gunzipAsync = promisify(gunzip);

/**
 * npm tgz 读写工具（docs/agents/managed-runtime.md 的构建身份一节）。
 *
 * 纯 Node 实现（gunzip + 手工扫/写 tar 512B 头），不依赖外部 tar——
 * 扩展宿主里 PATH/环境差异曾导致 spawnSync("tar") 静默失败。
 * 本模块无 vscode 依赖，可直接在 node:test 下跑。
 */

export interface BuildIdentity {
  name?: string;
  version: string;
  level?: number;
  /** ISO8601 打包时间戳——prepare-standalone --for-pack 戳进包内。 */
  builtAt?: string;
  gitSha?: string;
}

/** tar 512B 头扫描（ustar 前缀 + GNU 长名）——同步/异步两条读取共用的纯函数段。 */
function scanTarMembers(buf: Buffer, members: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const want = new Set(members);
  let off = 0;
  let longName: string | undefined;
  while (off + 512 <= buf.length && want.size > 0) {
    const head = buf.subarray(off, off + 512);
    const size = parseInt(
      head.subarray(124, 136).toString("utf8").replace(/\0[\s\S]*$/, "").trim() || "0",
      8,
    );
    if (!Number.isFinite(size)) break;
    const dataStart = off + 512;
    const rawName = head.subarray(0, 100).toString("utf8").replace(/\0[\s\S]*$/, "");
    if (!rawName) break; // 空块 = 归档尾
    const typeflag = String.fromCharCode(head[156]);
    if (typeflag === "L") {
      longName = buf.subarray(dataStart, dataStart + size).toString("utf8").replace(/\0[\s\S]*$/, "");
    } else {
      const prefix = head.subarray(345, 500).toString("utf8").replace(/\0[\s\S]*$/, "");
      const name = longName ?? (prefix ? `${prefix}/${rawName}` : rawName);
      longName = undefined;
      if (want.has(name)) {
        out.set(name, buf.subarray(dataStart, dataStart + size).toString("utf8"));
        want.delete(name);
      }
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** 读 tgz 内指定成员（同步）。 */
function tgzMembers(tgzPath: string, members: string[]): Map<string, string> {
  try {
    return scanTarMembers(gunzipSync(readFileSync(tgzPath)), members);
  } catch {
    // 解不出（非 gzip/非 tar）→ 空 map。
    return new Map();
  }
}

/** 异步变体：慢盘/网络盘上整包读+解压不再冻结扩展宿主事件循环。 */
async function tgzMembersAsync(tgzPath: string, members: string[]): Promise<Map<string, string>> {
  try {
    return scanTarMembers(await gunzipAsync(await fsp.readFile(tgzPath)), members);
  } catch {
    return new Map();
  }
}

const IDENTITY_MEMBERS = ["package/package.json", "package/pi-web-build.json"];

function identityFromMembers(members: Map<string, string>): BuildIdentity | undefined {
  const pkgRaw = members.get("package/package.json");
  if (!pkgRaw) return undefined;
  try {
    const p = JSON.parse(pkgRaw) as { name?: string; version?: string; piIde?: { level?: number } };
    if (!p.version) return undefined;
    const id: BuildIdentity = { name: p.name, version: p.version, level: p.piIde?.level };
    const stampRaw = members.get("package/pi-web-build.json");
    if (stampRaw) {
      const s = JSON.parse(stampRaw) as { builtAt?: string; gitSha?: string };
      id.builtAt = s.builtAt;
      id.gitSha = s.gitSha;
    }
    return id;
  } catch {
    return undefined;
  }
}

/** 读发行包 tgz 的构建身份（package/package.json + package/pi-web-build.json）。 */
export function readTgzIdentity(tgzPath: string): BuildIdentity | undefined {
  return identityFromMembers(tgzMembers(tgzPath, IDENTITY_MEMBERS));
}

/** 异步变体——启动/后台检查路径一律用它，同步版留给安装等冷路径。 */
export async function readTgzIdentityAsync(tgzPath: string): Promise<BuildIdentity | undefined> {
  return identityFromMembers(await tgzMembersAsync(tgzPath, IDENTITY_MEMBERS));
}

/**
 * 纯 Node 解 npm tgz 到 destPkgDir（= versions/<dir>/node_modules/<pkg>）。
 * 处理 ustar 前缀与 GNU 长名（'L'）头；'x'/'g'/symlink 成员跳过——
 * standalone junction 由启动时 linkExternalsToTraced 自愈，无需重建。
 */
export function extractTgz(tgzPath: string, destPkgDir: string): boolean {
  try {
    const buf = gunzipSync(readFileSync(tgzPath));
    let off = 0;
    let longName: string | undefined;
    while (off + 512 <= buf.length) {
      const head = buf.subarray(off, off + 512);
      const size = parseInt(
        head.subarray(124, 136).toString("utf8").replace(/\0[\s\S]*$/, "").trim() || "0",
        8,
      );
      if (!Number.isFinite(size)) break;
      const dataStart = off + 512;
      const dataEnd = dataStart + size;
      const rawName = head.subarray(0, 100).toString("utf8").replace(/\0[\s\S]*$/, "");
      if (!rawName) break; // 归档尾（空块）
      const typeflag = String.fromCharCode(head[156]);
      if (typeflag === "L") {
        // GNU 长名——数据段是真名，下一个头复用。
        longName = buf.subarray(dataStart, dataEnd).toString("utf8").replace(/\0[\s\S]*$/, "");
      } else {
        const prefix = head.subarray(345, 500).toString("utf8").replace(/\0[\s\S]*$/, "");
        const name = longName ?? (prefix ? `${prefix}/${rawName}` : rawName);
        longName = undefined;
        if (typeflag === "0" || typeflag === "" || typeflag === "5") {
          const rel = name.replace(/^package\//, "");
          // zip-slip 防御：成员必须落在 destPkgDir 内。
          const dest = path.resolve(destPkgDir, rel);
          if (rel && dest.startsWith(path.resolve(destPkgDir) + path.sep)) {
            if (typeflag === "5") {
              mkdirSync(dest, { recursive: true });
            } else {
              mkdirSync(path.dirname(dest), { recursive: true });
              writeFileSync(dest, buf.subarray(dataStart, dataEnd));
            }
          }
        }
      }
      off = dataStart + Math.ceil(size / 512) * 512;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * localPackage 配置值 → 实际 tgz 文件：
 * - 指向 .tgz 文件 → 直接返回；
 * - 指向目录 → 扫其中 *.tgz，读身份过滤包名匹配者（文件名随版本/构建
 *   变化没关系——看内容不看名），取 (version, builtAt) 最新者。
 * 找不到/无效返回 undefined。
 */
export function resolveLocalPackagePath(configPath: string, pkg: string): string | undefined {
  try {
    const st = statSync(configPath);
    if (st.isFile()) {
      return /\.t(ar\.)?gz$/i.test(configPath) ? configPath : undefined;
    }
    if (!st.isDirectory()) return undefined;
    let best: { file: string; version: string; builtAt: string } | undefined;
    for (const entry of readdirSync(configPath)) {
      if (!/\.t(ar\.)?gz$/i.test(entry)) continue;
      const file = path.join(configPath, entry);
      const id = readTgzIdentity(file);
      // pkg 传空 = 不限包名（installManagedLocalPackage 后再验名）。
      if (!id?.version || (pkg && id.name && id.name !== pkg)) continue;
      const builtAt = id.builtAt ?? "";
      if (
        !best ||
        compareVersions(id.version, best.version) > 0 ||
        (compareVersions(id.version, best.version) === 0 && builtAt > best.builtAt)
      ) {
        best = { file, version: id.version, builtAt };
      }
    }
    return best?.file;
  } catch {
    return undefined;
  }
}

/** 异步变体：目录模式下并发读各 tgz 身份，整段不占事件循环。 */
export async function resolveLocalPackagePathAsync(
  configPath: string,
  pkg: string,
): Promise<string | undefined> {
  try {
    const st = await fsp.stat(configPath);
    if (st.isFile()) {
      return /\.t(ar\.)?gz$/i.test(configPath) ? configPath : undefined;
    }
    if (!st.isDirectory()) return undefined;
    const files = (await fsp.readdir(configPath))
      .filter((entry) => /\.t(ar\.)?gz$/i.test(entry))
      .map((entry) => path.join(configPath, entry));
    const ids = await Promise.all(files.map((file) => readTgzIdentityAsync(file)));
    let best: { file: string; version: string; builtAt: string } | undefined;
    files.forEach((file, i) => {
      const id = ids[i];
      if (!id?.version || (pkg && id.name && id.name !== pkg)) return;
      const builtAt = id.builtAt ?? "";
      if (
        !best ||
        compareVersions(id.version, best.version) > 0 ||
        (compareVersions(id.version, best.version) === 0 && builtAt > best.builtAt)
      ) {
        best = { file, version: id.version, builtAt };
      }
    });
    return best?.file;
  } catch {
    return undefined;
  }
}
