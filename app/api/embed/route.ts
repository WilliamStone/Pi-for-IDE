import { readFileSync } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { BOOT_ID } from "@/lib/boot";
import { embedCapabilities } from "@/lib/embed/lifecycle";

// Embed 模式探测端点。
//
// 嵌入宿主（如 VSCode 扩展）在外部启动一个 pi-web 实例后，需要区分所连
// 服务器是否包含 embed 桥补丁——原版 pi-web 没有此路由（404），打过补丁
// 的返回 200 + 协议版本 + 能力表。宿主据此决定是否启用桥能力或提示安装正确版本。
const EMBED_PROTOCOL_VERSION = 1;

interface BuildStamp {
  builtAt?: string;
  gitSha?: string;
}

// pi-web-build.json 随发行包落在包根（bin 以 pkgDir 为 cwd 拉起 server）。
// 版本号在迭代期恒定，build 身份必须靠 builtAt/gitSha 区分——宿主 attach
// 多份并存副本时需要它判断"接上的是哪一份"。模块级缓存，每进程读一次。
let buildStamp: BuildStamp | null | undefined;
function readBuildStamp(): BuildStamp | null {
  if (buildStamp === undefined) {
    buildStamp = null;
    try {
      const raw = JSON.parse(readFileSync(path.join(process.cwd(), "pi-web-build.json"), "utf8")) as BuildStamp;
      buildStamp = { builtAt: raw.builtAt, gitSha: raw.gitSha };
    } catch {
      // 无戳环境（dev/手工 standalone）——字段缺省即可。
    }
  }
  return buildStamp;
}

export function GET() {
  // version 供宿主做版本/协议兼容性提示（扩展据此判断该升级哪一侧）。
  // capabilities：可选特性按名探测，缺失即降级（docs/agents/embed-protocol.md）。
  // boot：本进程实例标识——跨进程重启后必变，宿主比它判断要不要刷新嵌入页。
  // builtAt/gitSha/installRoot：构建与安装副本身份——多份并存时宿主靠它
  // 区分"attach 上的是哪一份"（同版本不同 build 在 version 上不可区分）。
  const stamp = readBuildStamp();
  return NextResponse.json({
    embed: {
      protocol: EMBED_PROTOCOL_VERSION,
      version: process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0",
      boot: BOOT_ID,
      capabilities: embedCapabilities(),
      installRoot: process.cwd(),
      ...(stamp?.builtAt ? { builtAt: stamp.builtAt } : {}),
      ...(stamp?.gitSha ? { gitSha: stamp.gitSha } : {}),
    },
  });
}
