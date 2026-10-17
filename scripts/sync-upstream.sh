#!/usr/bin/env bash
# 同步上游 pi-web 到本仓 main：fetch agegr-pi-web 的 tag 并三方合并，
# 随后跑 install + typecheck + lint + test 验证。
#
# 用法: scripts/sync-upstream.sh <tag>    例如 scripts/sync-upstream.sh v0.12.1
#
# 冲突面由"最小上游面"原则控制；出现冲突时人工解决后 git commit 完成合并。
# 合并前先读 docs/agents/upstream-sync.md（保留我方文件清单 + Windows 测试手册）。
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="${1:?用法: $0 <tag>，如 v0.12.1}"

print_keep_ours() {
  echo ">>> 保留我方内容的文件（resolve 时以本仓为准）:" >&2
  echo ">>>   package.json / package-lock.json   包名/版本/bin/repo/standalone 打包" >&2
  echo ">>>   README.md / docs/README.*          产品文档（上游写的是 @agegr/pi-web）" >&2
  echo ">>>   lib/brand.ts / app/manifest.ts     Pi Web+ / Pi for IDE 品牌" >&2
  echo ">>>   lib/embed/** components/embed/**   embed 适配层（我方独有）" >&2
  echo ">>>   hooks/useEmbed* / useI18n.tsx      embed 钩子 / i18n 默认语言 en" >&2
  echo ">>>   bin/pi-web-*.js scripts/           standalone 打包与更新" >&2
  echo ">>>   vscode-extension/**                扩展（我方独有）" >&2
  echo ">>>   lib/i18n/messages/* lib/embed/     合并上游键，保留我方键" >&2
}

git fetch agegr-pi-web --tags

if ! git merge --no-edit "$TAG" -m "chore: 同步上游 pi-web $TAG"; then
  print_keep_ours
  echo ">>> 存在合并冲突：解决后 git commit 完成合并，再手动执行验证步骤：" >&2
  echo ">>>   npm install && node_modules/.bin/tsc --noEmit && npm run lint && npm test" >&2
  exit 1
fi

npm install --no-audit --no-fund
node_modules/.bin/tsc --noEmit
npm run lint

# 全套测试跑后台日志（~10-25min），失败详情不会淹没在刷屏里。
TEST_LOG="${TMPDIR:-/tmp}/pi-web-sync-test-${TAG#v}.log"
echo ">>> 跑 npm test（日志：$TEST_LOG）…" >&2
if npm test >"$TEST_LOG" 2>&1; then
  tail -12 "$TEST_LOG"
  echo ">>> 同步 $TAG 完成，install/typecheck/lint/test 全过。"
else
  echo ">>> 测试有失败，详见 $TEST_LOG；对照 docs/agents/upstream-sync.md 的 Windows 手册先查模式。" >&2
  grep -c "^✖\|✖ " "$TEST_LOG" || true
  exit 1
fi
