# 发布指南：npm 包 + VSCode 商店 + Open VSX

> 面向维护者。用户侧安装指引见 `vscode-extension-deploy.md`。

## 1. 发布 `pi-web-for-ide` 到 npmjs.com

### 首次准备

```bash
npm login          # 浏览器跳转 npmjs.com 完成认证（一次即可）
```

`package.json` 已就绪：`name: pi-web-for-ide`（unscoped，公开包免费）、`files` 白名单、`prepack` 钩子会在发布前自动重建 standalone 产物并清理旧 tarball。

### 发布

```bash
npm version patch        # 或 minor/major——先抬版本号（npm 不允许重复版本）
npm publish              # prepack 自动跑构建+standalone 组装（约 2-3 分钟）
```

### 验证

```bash
npm view pi-web-for-ide version
pnpm i -g pi-web-for-ide
pi-web --version
```

### 注意

- tarball ~34-67MB，发布后 `npx pi-web-for-ide` 也能跑（首次联网下载）
- postinstall 必须在用户机器上执行（junction 建链）——pnpm 默认允许；npm 用户若拦脚本，见 deploy 文档排障节
- 上游合并发版流程：合并 tag → `npm version` → `npm publish`

## 2. 发布 `pi-for-ide` 到 VSCode Marketplace（微软官方商店）

### 一次性准备

1. 用你的 GitHub/微软账号登录 [Azure DevOps](https://dev.azure.com)（发布走它的 PAT）。
2. Azure DevOps → 右上角头像 → **Personal access tokens** → New Token：
   - Organization：`All accessible organizations`
   - Scope：勾 **Marketplace → Manage**
   - 记下 PAT（只显示一次）
3. 到 [Marketplace 发布者管理页](https://marketplace.visualstudio.com/manage) 创建 publisher：
   - **ID 必须是 `WilliamStone`**（与 `vscode-extension/package.json` 的 `publisher` 字段一致）
   - Name 可自由填展示名

### 发布

```bash
cd vscode-extension
npx vsce login WilliamStone        # 粘贴 PAT（一次即可）
npx vsce publish                   # 或 --packagePath pi-for-ide-0.1.0.vsix 直接发已打好的包
```

`vsce publish` 会先跑 `vscode:prepublish`（compile）再上传；增量发版用 `npx vsce publish patch` 自动抬版本。

### 上架前建议补齐（可选但推荐）

- `vscode-extension/` 下补 `LICENSE` 文件（仓根有 MIT，扩展目录内单独放一份，商店页会显示）
- `readme.md` 里的截图 `screen.png` 已打包 ✓
- marketplace 链接徽标等按需在扩展 `package.json` 的 `galleryBanner`/`badges` 加

## 3. 发布到 Open VSX（VSCodium/Cursor 等开源商店）

> VSCodium 默认商店就是 Open VSX——你的目标用户大概率从这装。

### 一次性准备

1. 注册 [open-vsx.org](https://open-vsx.org) 账号（用 GitHub 登录），并完成 Eclipse Foundation **Publisher Agreement**（在线签署，在个人设置页）。
2. 在 open-vsx.org 用户设置里创建 **Access Token**。
3. 创建命名空间（与 publisher 同名）：

```bash
npx ovsx create-namespace WilliamStone -p <token>
```

### 发布

```bash
cd vscode-extension
npx ovsx publish pi-for-ide-0.1.0.vsix -p <token>
# 或从目录直接构建发布：
npx ovsx publish -p <token>
```

## 4. 升级链路（两商店+npm 的配套行为，已实现）

- **用户只装扩展没装包**：扩展找不到服务器时弹「一键安装」按钮——自动选 pnpm（无则 npm）全局安装 `pi-web-for-ide`，装完自动重试解析并拉起；npx 兜底路径在包发布后自动生效（首次联网下载）。
- **包发新版后的升级提示**：扩展启动后约 8s 后台查 npm registry `pi-web-for-ide/latest` 与本地全局安装版本比对，有新版弹「立即升级」→ 全局重装 → 提示重启服务器生效。executablePath/npx 用户定位不到本地副本时静默跳过。
- **页面内的更新检查**（pi-web 自带）：已改为查 `pi-web-for-ide` 的 npm latest，发布说明链接指向本仓 releases。
- **`pi-web update`**：CLI 自升级命令，动态读包名，已兼容新名。
