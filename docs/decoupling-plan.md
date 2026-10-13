# PI Code 解耦与多宿主适配规划

> 状态：已确认的方向性文档。记录总原则、分支布局、分层拆解与执行步骤。
> 细节设计在执行各步时另行评审。

## 背景与目标

本仓库 = pi-web（上游 `agegr/pi-web`）+ VSCode 适配 delta + `vscode-extension/`。
现状问题：delta 与 pi-web 源码混在一起、内置打包导致 vsix >120MB、pi/pi-web 版本陈旧且无法独立更新。

**目标形态**：

- VSCode 扩展瘦身成薄壳（<1MB），运行时调用**外部安装**的 pi-web；
- 本仓对 pi-web 的 delta 重构为**宿主无关的 embed（嵌入宿主）抽象层**——不绑死 VSCode，保留适配其他 IDE/宿主的能力，VSCode 是第一个宿主实现；
- pi 版本跟随 pi-web（pi 是 pi-web 的进程内依赖，无独立进程边界；pi-web 高速更新期不自行外置，上游停更后再议）。

## 已确认的架构事实

- 扩展 ↔ pi-web 之间已是进程间协议：HTTP（iframe 加载页面）+ postMessage 双向桥。
- 上游 pi-web **没有**任何 embed/vscode 代码；本仓 delta 独有（~1500 行）。
- pi-web 进程内 import `@earendil-works/pi-coding-agent` 创建 AgentSession；pi 没有可作为独立服务的边界（pi 虽有 JSONL RPC 模式，但 pi-web 未使用）。
- 本仓 `WilliamStone/pi-code` 处于 agegr/pi-web 的 fork 网络内 → 可直接向两个上游提 PR；GitHub "单 fork" 限制只限 repo 数量，不限 git remote/branch。

## 总原则

### 1. 宿主抽象（embed host mode）

所有 delta 按"宿主无关协议 + 宿主适配器"组织：

- 页面侧只认通用 embed 协议，不识具体宿主。命名去 vscode 化：
  - `?vscode=1` → `?embed=<hostId>`（如 `?embed=vscode`）；
  - `lib/vscode-bridge.ts` → `lib/embed/` 模块；消息 `source:"vscode"` → `"host"` 方向语义化；
  - 各功能声明为**能力（capability）**：页面可通过握手询问宿主支持哪些能力，按能力优雅降级（替代现在"请求超时=无能力"的隐式降级，也顺带解决"误连原版 pi-web"的检测）。
- `vscode-extension/` 是该协议在 VSCode 上的适配器实现；未来 JetBrains 等其他宿主实现同一协议即可复用页面侧全部功能。
- 三个功能批都按此原则：基建批（桥 + embed 模式识别 + UI 隐藏）、交互批（mention/活动编辑器/剪贴板）、重功能批（文件审查/diff/回退 + 服务端 systemPrompt 注入）。

### 2. delta 最小面

- 功能代码集中到 `lib/embed/`、`components/embed/` 等新文件（新文件零冲突）。
- 上游文件内的插入点压成单行挂钩（hook 调用、单组件挂载点）。
- **功能性 delta 与改名/打包噪音分离**："Pi Web→PI Code" 类字符串改动剥成独立的 `branding` 提交/patch（或放弃改名），不与功能 delta 混杂。
- i18n 新字符串放独立文件运行时合并，不改上游 messages 文件。

### 3. 单仓多血统

不加新 fork。remote/branch 表达全部关系：

```
remotes:
  origin    = WilliamStone/pi-code      （本仓）
  upstream  = wangjinxin613/pi-code     （扩展代码来源；若复活可合并）
  agegr     = agegr/pi-web              （pi-web 上游）

branches:
  main          = 产品分支：embed 抽象层 + vscode-extension/ + 打过 delta 的 pi-web 树
  delta/embed   = 可 rebase 的 delta 提交序列，建在 pi-web 上游 tag 上
                  （上游有 vX.Y.Z 形式的 tag；当前基线 v0.8.5 = cbb080d）
```

- `upstream/main` 远程跟踪分支即承担"pi-code-upstream"角色，不另建本地分支。
- 向 agegr/pi-web 上游化 PR 时，从本仓分支直接发起（同网络内合法）。

### 4. delta 的可移植性（patch 队列形态）

delta 维护为按功能切分的提交序列；`git format-patch` 可导出为 `patches/*.patch`，apply 到**任何 pi-web 系 checkout**（含 omp-web）。

- omp-web 定位：**支持而非维护**——提供 apply 通道，冲突由使用方解决，不承诺兼容。
- 导出 patch 时过滤 `vscode-extension/`、`docs/decoupling-plan.md` 等产品侧路径。

### 5. 升级工作流

目标命令（机械部分全自动，语义冲突才人工）：

```
scripts/sync-upstream.sh <vX.Y.Z>
  = git fetch agegr
  + git rebase --onto <new-tag> <old-tag> delta/embed
  + npm install + tsc --noEmit + lint
scripts/export-patches.sh   → patches/*.patch
scripts/apply-to.sh <dir>   → 把 patch 应用到指定 checkout（omp-web 等）
```

降低冲突概率的真正手段是原则 2（最小面），不是工具。

## 功能批拆解（重构目标态）

| 批 | 内容 | 主要触及 |
|---|---|---|
| 基建 | embed 协议（请求/响应/通知/能力握手）、`?embed=` 模式识别、隐藏文件浏览器 UI | `lib/embed/` 新文件 + AppShell 小改 |
| 交互 | mention 注入输入框、@ 补全走宿主、活动编辑器注入、剪贴板桥 | ChatInput/AppShell/useAgentSession 单行挂钩 |
| 重功能 | 文件审查卡片、turn 快照、diff 展示、回退、活动文件注入 systemPrompt（服务端） | FileReviewCard/file-changes/revert-turn 新文件 + ChatWindow/MessageView/rpc-manager 挂钩 |

上游化（可选、远期）：可按同样三批递进提 PR，包装为通用 "embeddable host mode"；被上游拒收的部分永久留在 patch 层，不影响本仓。

## 执行步骤

1. **delta 瘦身重构**：剥离改名噪音；嵌入侧代码收进 `lib/embed/`、`components/embed/`；上游文件插入点单行化；拆成按功能切分的提交序列（建在 `delta/embed`）。
2. **扩展侧改造**：`piWebServer.ts` 实现外部 pi-web 解析（`piWeb.executablePath` → PATH → `npm root -g` → `npx -y <pkg>` 兜底，自动下载保留"装扩展即用"体验）；能力检测端点；去掉 `package:pi-web` 打包步骤。
3. **同步上游**：`sync-upstream` 脚本落地，rebase 到最新 release 提交，回归测试。
4. **发布形态**：本仓 pi-web 以独立包名发 npm（包名待定）；文档更新安装/升级说明。
5. **可选**：上游化 PR；omp-web apply 通道验证。

## 决策记录

- **pi 不外置**：pi 是 pi-web 进程内依赖，跟随 pi-web 版本；pi-web 高速更新期不做 SDK 外挂。若上游停更，再评估 `update-sdk`（npm 树内换版本）或 RPC 子进程方案。
- **不新增 GitHub fork**：单仓多 remote/branch 已覆盖全部需求，且保留 PR 通道。
- **omp-web**：patch 可移植性保留该选项，仅提供 apply 机制，不主动维护兼容。
- **上游化**：不作为当前目标；delta 按可上游化的标准设计（通用 embed 语义、无 vscode 硬编码），保留可能性。
