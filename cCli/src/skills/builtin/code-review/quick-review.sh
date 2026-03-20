#!/usr/bin/env bash
# 快速 diff 分析脚本 — 用于代码审查前的概况扫描
# 用法: ./quick-review.sh [基准分支]
# 示例: ./quick-review.sh main
#       ./quick-review.sh        # 默认基准分支为 main

set -euo pipefail

BASE="${1:-main}"
DIVIDER="────────────────────────────────────────"

echo "🔍 代码审查: 与 $BASE 分支的差异"
echo "$DIVIDER"
echo ""

# --- 1. 变更文件概览 ---
echo "📂 变更文件:"
echo ""
git diff --stat "$BASE"...HEAD 2>/dev/null || git diff --stat "$BASE"
echo ""

# --- 2. Diff 大小检查 ---
ADDITIONS=$(git diff "$BASE"...HEAD --numstat 2>/dev/null | awk '{s+=$1}END{print s+0}' || echo 0)
DELETIONS=$(git diff "$BASE"...HEAD --numstat 2>/dev/null | awk '{s+=$2}END{print s+0}' || echo 0)
TOTAL=$((ADDITIONS + DELETIONS))

echo "📊 变更规模: +$ADDITIONS / -$DELETIONS (共 $TOTAL 行)"
if [ "$TOTAL" -gt 500 ]; then
  echo "   ⚠️  大型 diff (>500 行) — 建议拆分为更小的 PR"
elif [ "$TOTAL" -gt 200 ]; then
  echo "   ⚡ 中型 diff — 建议逐文件审查"
else
  echo "   ✅ 小型 diff — 可以内联审查"
fi
echo ""

# --- 3. 风险扫描 ---
echo "🛡️  风险扫描:"
echo ""

RISK_FOUND=0

# 安全敏感模式
SECURITY_HITS=$(git diff "$BASE"...HEAD 2>/dev/null | grep -c -E '(password|secret|token|api.?key|private.?key|innerHTML|dangerouslySetInnerHTML|eval\(|exec\(|\.load\()' || true)
if [ "$SECURITY_HITS" -gt 0 ]; then
  echo "   🔴 安全: $SECURITY_HITS 行匹配敏感模式 (password/secret/token/eval/exec)"
  RISK_FOUND=1
fi

# 异常处理模式
CATCH_EMPTY=$(git diff "$BASE"...HEAD 2>/dev/null | grep -c -E 'catch\s*\{?\s*\}|except:\s*$|catch\s*\(\s*\w*\s*\)\s*\{\s*\}' || true)
if [ "$CATCH_EMPTY" -gt 0 ]; then
  echo "   🟡 异常处理: 检测到 $CATCH_EMPTY 个空 catch/except 块"
  RISK_FOUND=1
fi

# TODO/FIXME/HACK 标记
TODO_HITS=$(git diff "$BASE"...HEAD 2>/dev/null | grep -c -E '(TODO|FIXME|HACK|XXX)' || true)
if [ "$TODO_HITS" -gt 0 ]; then
  echo "   🟡 技术债: diff 中有 $TODO_HITS 个 TODO/FIXME/HACK 标记"
  RISK_FOUND=1
fi

# 大文件变更 (>300 行)
echo ""
LARGE_FILES=$(git diff "$BASE"...HEAD --numstat 2>/dev/null | awk '$1+$2 > 300 {print "   ⚠️  " $3 " (+" $1 " / -" $2 ")"}')
if [ -n "$LARGE_FILES" ]; then
  echo "   📦 大文件变更 (>300 行):"
  echo "$LARGE_FILES"
  RISK_FOUND=1
fi

if [ "$RISK_FOUND" -eq 0 ]; then
  echo "   ✅ 未检测到明显风险"
fi

echo ""
echo "$DIVIDER"
echo "运行 'git diff $BASE...HEAD' 查看完整差异"
