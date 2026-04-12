#!/bin/bash
set -euo pipefail

##
# SubAgent 全栈项目创建 E2E 测试（Shell 版）
#
# 通过管道模式 (pipe mode) 驱动 cCli，验证 SubAgent 并行搭建全栈项目。
#
# 兼容 Git Bash / MSYS2 / Linux Bash
# 用法（从项目根目录执行）：
#   bash tests/e2e/test-subagent-fullstack.sh
# 或从当前目录执行：
#   bash test-subagent-fullstack.sh
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKSPACE="C:\Users\ThinkPad\Desktop\新建文件夹"

TSX="$PROJECT_ROOT/node_modules/.bin/tsx"
TSCONFIG="$PROJECT_ROOT/tsconfig.json"
CLI_ENTRY="$PROJECT_ROOT/bin/ccli.ts"

echo "╔═══════════════════════════════════════════════════════════╗"
echo "║  SubAgent 全栈项目 E2E 测试                              ║"
echo "╠═══════════════════════════════════════════════════════════╣"
echo "║  工作目录: $WORKSPACE"
echo "║  cCli 根目录: $PROJECT_ROOT"
echo "╚═══════════════════════════════════════════════════════════╝"

mkdir -p "$WORKSPACE"

# prompt 写临时文件，避免 shell 转义问题
PROMPT_FILE="$(mktemp)"
trap 'rm -f "$PROMPT_FILE"' EXIT

cat > "$PROMPT_FILE" <<PROMPT_EOF
你是一个全栈工程师，请在 $WORKSPACE 目录下完成以下任务。
必须使用 dispatch_agent 工具派发子 Agent 并行执行。

## SubAgent 1：后端（Python FastAPI）

在 $WORKSPACE/backend/ 目录下搭建后端项目：
1. 创建 backend 目录，进入后执行 \`uv init\` 初始化
2. \`uv add fastapi uvicorn\` 安装依赖
3. 创建 backend/main.py：
   - FastAPI 应用 + CORS 中间件（允许 http://localhost:9092）
   - GET /hello 接口，返回 {"message": "helloworld"}
4. 完成后验证：执行 \`cd $WORKSPACE/backend && uv run python -c "from main import app; print('backend OK')"\` 确认导入无误

## SubAgent 2：前端（Vue + Vite）

在 $WORKSPACE/ 下搭建前端项目：
1. \`npm create vue@latest frontend -- --default\` 创建项目
2. \`cd frontend && npm install && npm install axios\`
3. 修改 vite.config.ts，设置 server.port 为 9092
4. 修改 src/App.vue：页面加载时 axios 调用 http://localhost:9091/hello，显示返回的 message
5. 完成后验证：执行 \`cd $WORKSPACE/frontend && npx vue-tsc --noEmit 2>&1 || true\` 检查 TS 是否有严重错误

## SubAgent 3：运维脚本 + 验证

在 $WORKSPACE/ 下创建交互式运维脚本，启动后显示数字菜单让用户选择操作：

### run.bat（Windows CMD）
脚本启动后循环显示菜单：
\`\`\`
=============================
  项目管理
=============================
  1. 启动所有服务
  2. 停止所有服务
  3. 查看服务状态
  4. 退出
=============================
请选择:
\`\`\`
- 选 1：后台启动后端（cd backend && uv run uvicorn main:app --port 9091）和前端（cd frontend && npm run dev）
- 选 2：按端口 9091 和 9092 查杀进程（netstat + taskkill）
- 选 3：检查 9091 和 9092 端口是否被占用，显示运行状态
- 选 4：退出脚本
- 选完后回到菜单继续，直到选 4 退出

### run.sh（Bash / Git Bash）
同样的交互式菜单，逻辑一致：
- 选 1：后台启动，PID 写入 .pids 文件
- 选 2：读 .pids 或按端口查杀
- 选 3：检查端口占用状态
- 选 4：退出

### 验证步骤（必须执行）
1. \`bash -n $WORKSPACE/run.sh\` 检查语法
2. 如果有语法错误，修复后重新验证，直到通过

所有 SubAgent 完成后，汇总每个子任务的执行结果和验证结论。
PROMPT_EOF

PROMPT="$(cat "$PROMPT_FILE")"

echo ""
echo "▶ 启动 cCli 管道模式..."

START_TS=$(date +%s)
START_TIME=$(date "+%Y-%m-%d %H:%M:%S")
echo "  开始时间: $START_TIME"
echo ""

cd "$WORKSPACE"

"$TSX" --tsconfig "$TSCONFIG" "$CLI_ENTRY" \
  -p "$PROMPT" \
  --yes \
  --verbose

EXIT_CODE=$?

END_TS=$(date +%s)
END_TIME=$(date "+%Y-%m-%d %H:%M:%S")
ELAPSED=$((END_TS - START_TS))
ELAPSED_MIN=$((ELAPSED / 60))
ELAPSED_SEC=$((ELAPSED % 60))

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  cCli 退出码: $EXIT_CODE"
echo "  开始时间:    $START_TIME"
echo "  结束时间:    $END_TIME"
echo "  耗时:        ${ELAPSED_MIN}m ${ELAPSED_SEC}s"
echo "═══════════════════════════════════════════════════════════"

# ── 验证产出物 ──
echo ""
echo "▶ 验证产出物..."
PASSED=0
FAILED=0

check_file() {
  if [ -e "$2" ]; then
    echo "  ✓ $1"
    PASSED=$((PASSED + 1))
  else
    echo "  ✗ $1 (不存在: $2)"
    FAILED=$((FAILED + 1))
  fi
}

check_content() {
  if [ -f "$2" ] && grep -q "$3" "$2"; then
    echo "  ✓ $1"
    PASSED=$((PASSED + 1))
  else
    echo "  ✗ $1"
    FAILED=$((FAILED + 1))
  fi
}

# 后端
check_file    "backend/main.py"               "$WORKSPACE/backend/main.py"
check_file    "backend/pyproject.toml"        "$WORKSPACE/backend/pyproject.toml"
check_content "main.py 包含 helloworld"              "$WORKSPACE/backend/main.py"           "helloworld"
check_content "main.py 包含 CORS"                    "$WORKSPACE/backend/main.py"           "CORSMiddleware"
# 前端
check_file    "frontend/package.json"         "$WORKSPACE/frontend/package.json"
check_file    "frontend/vite.config.ts"       "$WORKSPACE/frontend/vite.config.ts"
check_file    "frontend/src/App.vue"          "$WORKSPACE/frontend/src/App.vue"
check_content "vite.config.ts 包含端口 9092"         "$WORKSPACE/frontend/vite.config.ts"   "9092"
check_content "App.vue 调用后端 9091"                "$WORKSPACE/frontend/src/App.vue"      "9091"
check_content "package.json 包含 axios"              "$WORKSPACE/frontend/package.json"     "axios"
# 运维脚本
check_file    "run.bat"                       "$WORKSPACE/run.bat"
check_file    "run.sh"                        "$WORKSPACE/run.sh"
check_content "run.bat 包含菜单选项"                 "$WORKSPACE/run.bat"                   "请选择"
check_content "run.bat 包含 9091"                    "$WORKSPACE/run.bat"                   "9091"
check_content "run.bat 包含 9092"                    "$WORKSPACE/run.bat"                   "9092"
check_content "run.sh 包含菜单选项"                  "$WORKSPACE/run.sh"                    "请选择"
check_content "run.sh 包含 9091"                     "$WORKSPACE/run.sh"                    "9091"
check_content "run.sh 包含 9092"                     "$WORKSPACE/run.sh"                    "9092"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  验证结果: $PASSED passed, $FAILED failed"
echo "═══════════════════════════════════════════════════════════"

[ "$FAILED" -eq 0 ] || exit 1
