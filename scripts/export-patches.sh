#!/usr/bin/env bash
# 导出本仓 delta（相对上游基线 tag 的净差异）为两个 patch：
#   embed-delta.patch   — 纯功能：embed 桥协议 + 全部宿主交互/审查/回退代码
#   product-delta.patch — 产品侧：品牌改名、默认语言/主题、仓库配置、扩展本体
# 拆分的意义：embed-delta 可应用到任意 pi-web 系 checkout（上游版本、
# omp-web 等）而不带入 PI Code 品牌与产品配置。
#
# 用法: scripts/export-patches.sh [基线tag] [输出目录]
#   默认: scripts/export-patches.sh v0.8.5 patches
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${1:-v0.8.5}"
OUTDIR="${2:-patches}"
mkdir -p "$OUTDIR"

# 非功能路径：产品侧（扩展本体、品牌、产品偏好）与仓库侧（文档、配置、
# 依赖 pin）。这些差异不进 embed-delta，而是单独导出为 product-delta。
PRODUCT_PATHS=(
  'vscode-extension/**'
  'docs/**'
  'patches/**'
  'scripts/**'
  'README*.md'
  'AGENTS.md'
  'package.json'
  'package-lock.json'
  'tsconfig.json'
  'eslint.config.mjs'
  'next.config.ts'
  '.gitignore'
  # 纯品牌/产品偏好：不含 embed 功能代码。
  'app/manifest.ts'
  'bin/node-version.js'
  'components/PwaRegistration.tsx'
  'components/SessionSidebar.tsx'
  'hooks/useI18n.tsx'
  'hooks/useTheme.ts'
  'lib/project-trust.ts'
  'proxy.ts'
  'public/offline.html'
)

EXCLUDES=()
for p in "${PRODUCT_PATHS[@]}"; do
  EXCLUDES+=(":(exclude)$p")
done

git diff "$BASE"..HEAD -- . "${EXCLUDES[@]}" > "$OUTDIR/embed-delta.patch"
git diff "$BASE"..HEAD -- "${PRODUCT_PATHS[@]}" > "$OUTDIR/product-delta.patch"

echo "written: $OUTDIR/embed-delta.patch   ($(wc -l < "$OUTDIR/embed-delta.patch" | tr -d ' ') lines)"
echo "written: $OUTDIR/product-delta.patch ($(wc -l < "$OUTDIR/product-delta.patch" | tr -d ' ') lines)"
