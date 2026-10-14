#!/usr/bin/env bash
# 把 embed delta patch 应用到任意 pi-web 系 checkout（如 omp-web）。
#
# 用法: scripts/apply-to.sh <目标 checkout 目录> [patch 文件]
#   默认 patch: patches/embed-delta.patch（先跑 export-patches.sh 生成）
#
# 优先 git apply --3way（目标仓有共享历史时三方合并）；失败回退 --reject，
# 冲突 hunk 写入 .rej 文件由人工合并。
set -euo pipefail
cd "$(dirname "$0")/.."

DIR="${1:?用法: $0 <目标 checkout 目录> [patch 文件]}"
PATCH="${2:-patches/embed-delta.patch}"
PATCH_ABS="$(cd "$(dirname "$PATCH")" && pwd)/$(basename "$PATCH")"

cd "$DIR"
if git apply --3way --whitespace=fix "$PATCH_ABS" 2>/dev/null; then
  echo ">>> 应用成功（3way）。"
else
  echo ">>> --3way 应用失败，回退到 --reject；冲突 hunk 写入 .rej 文件：" >&2
  git apply --reject --whitespace=fix "$PATCH_ABS" || true
  find . -name '*.rej' -not -path './node_modules/*'
  echo ">>> 请按 .rej 文件手工合并后 git add。" >&2
  exit 1
fi
