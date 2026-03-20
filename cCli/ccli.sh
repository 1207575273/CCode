#!/usr/bin/env bash
# 在任意目录启动 cCli（开发模式）
# 用法: bash /d/a_dev_work/claude_cli_z01/cCli/zcli.sh [args...]
# 建议: alias ccode='bash /d/a_dev_work/claude_cli_z01/cCli/zcli.sh'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec npx --prefix "$SCRIPT_DIR" tsx --tsconfig "$SCRIPT_DIR/tsconfig.json" "$SCRIPT_DIR/bin/ccli.ts" "$@"
