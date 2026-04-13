#!/bin/bash
##
# SubAgent 停止机制 E2E 测试 — 兼容入口
#
# 此脚本已拆分为独立子测试，请使用新入口：
#   bash tests/e2e/run-subagent-stop-e2e.sh         # 全部执行
#   bash tests/e2e/e2e-01-background-task-output.sh  # 单独执行
#
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/run-subagent-stop-e2e.sh" "$@"
