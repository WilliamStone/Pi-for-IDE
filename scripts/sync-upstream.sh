#!/usr/bin/env bash
# 同步上游 pi-web 到本仓 main：fetch agegr-pi-web 的 tag 并三方合并，
# 随后跑 install + typecheck + lint 验证。
#
# 用法: scripts/sync-upstream.sh <tag>    例如 scripts/sync-upstream.sh v0.12.1
#
# 冲突面由"最小上游面"原则控制；出现冲突时人工解决后 git commit 完成合并。
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="${1:?用法: $0 <tag>，如 v0.12.1}"

git fetch agegr-pi-web --tags

if ! git merge --no-edit "$TAG" -m "chore: 同步上游 pi-web $TAG"; then
  echo ">>> 存在合并冲突：解决后 git commit 完成合并，再手动执行：" >&2
  echo ">>>   npm install && node_modules/.bin/tsc --noEmit && npm run lint" >&2
  exit 1
fi

npm install --no-audit --no-fund
node_modules/.bin/tsc --noEmit
npm run lint
echo ">>> 同步 $TAG 完成，检查通过。"
