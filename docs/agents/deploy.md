# Pi for IDE — 打包 / 部署 / 实机验证手册

每次"改完→打包→装→验"的循环照这份走。发版流程（版本号、registry
发布）见上级 发版操作手册。

## 打包

```powershell
# 扩展（prepublish 自动 compile，不用单独跑）
cd vscode-extension
npm run package          # → pi-for-ide-<ver>.vsix

# web 包（prepack 内部自动跑完整 build，~4min）
cd ..
npm pack                 # → william_stone-pi-web-for-ide-<ver>.tgz
```

PowerShell 旧版本不支持 `&&` 链——分两条跑。

## 安装前的清场：停止运行中的 pi-web 服务

**全局安装 npm 包会被运行中的服务锁定文件**——先停再装。

`bin/preinstall-guard.js` 已把这道坎前移：Windows 上检出在跑实例时
`pnpm i -g` 会用人话中止（列出 pid/url + 停法），而不是装到一半炸
`os error 32`。非 Windows 只警告不拦（POSIX 不锁在用文件）。

按归属选停法：

| 实例 | 停法 |
|---|---|
| 扩展自己拉起的（log 见 `spawn:`） | 命令面板 `Pi for IDE: Stop Server` |
| attach 进来的别家实例 | **不杀**（attach≠adopt）——确需释放端口/文件时按 PID 定点 |
| 无主的旧版/standalone 孤儿 | `Stop-Process -Id <pid> -Force`（**只按 PID**，禁止按进程名广谱杀） |

查谁占着：`netstat -ano | findstr "303[0-9].*LISTEN"`（303x 是
Pi Web 默认扫描段）。

**残留的判别**：watchdog 是本轮才加的——老版本（≤0.12.1-x）起的
进程没有自退机制，装新版前总会撞一个；关掉所有窗口/浏览器页后
`netstat` 仍有 LISTEN 的就是它。

## 安装

```powershell
# npm 包（全局——腿序见 managed-runtime.md §3）
pnpm install -g S:\DevSpace\AI\Agents\pi-code\william_stone-pi-web-for-ide-0.12.2-1.tgz

# 扩展（先卸旧版再装，或直接覆盖安装）
code --install-extension vscode-extension\pi-for-ide-0.1.8.vsix
```

免全局包的替代：`Pi for IDE.executablePath` 指
`<repo>\bin\pi-web.js`（repo 内的 standalone 就是新构建）——
解析链腿 1，最高优先。

## 实机验证清单

- **面板链路**：`Pi for IDE: Open` → 等待页 → iframe 出页面。
  日志应见 `shell painted → server probe passed → iframe page loaded`
- **服务器版本**：日志 `embed handshake OK … version X.Y.Z-N`
  必须等于新装版本；不等于说明 attach 到了残留旧实例（先停它）
- **择优日志**：多副本共存时 `pi-web entry` 行尾带
  `(newest of N installed copies)`
- **回退/diff**：edit 文件 diff 双侧有内容；write 新建回退删文件；
  漂移文件降级到 recorded patch（非左空伪全增）
- **生命周期**：两个窗口同 cwd → 第二窗 `attached to running`；
  全关 ~90s 服务自退；浏览器页开着时不被杀
- **standalone 存活**：`pi-web-for-ide` 手动起的实例不受 watchdog 影响
