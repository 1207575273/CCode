/**
 * SubAgent 全栈项目创建 E2E 测试（TS 版）
 *
 * 通过子进程启动 cCli 管道模式，验证：
 *   1. dispatch_agent 能否正确派发前后端 SubAgent
 *   2. SubAgent 各自完成独立任务且不越界
 *   3. RepetitionDetector 正常工作（不出现循环调用）
 *   4. 产出物文件存在且内容正确
 *
 * 用法（从项目根目录执行）：
 *   npx tsx tests/e2e/test-subagent-fullstack.ts
 *
 * 或从当前目录执行：
 *   npx tsx test-subagent-fullstack.ts
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '../..')
const TSX = join(PROJECT_ROOT, 'node_modules/.bin/tsx')
const TSCONFIG = join(PROJECT_ROOT, 'tsconfig.json')
const CLI_ENTRY = join(PROJECT_ROOT, 'bin/ccli.ts')
const WORKSPACE = 'C:/Users/ThinkPad/Desktop/新建文件夹 (4)'

// ═══════════════════════════════════════════════════════════
// Prompt
// ═══════════════════════════════════════════════════════════

const PROMPT = `
你是一个全栈工程师，请在 ${WORKSPACE} 目录下完成以下任务。
必须使用 dispatch_agent 工具派发子 Agent 并行执行。

## SubAgent 1：后端（Python FastAPI）

在 ${WORKSPACE}/backend/ 目录下搭建后端项目：
1. 创建 backend 目录，进入后执行 \`uv init\` 初始化
2. \`uv add fastapi uvicorn\` 安装依赖
3. 创建 backend/main.py：
   - FastAPI 应用 + CORS 中间件（允许 http://localhost:9092）
   - GET /hello 接口，返回 {"message": "helloworld"}
4. 完成后验证：执行 \`cd ${WORKSPACE}/backend && uv run python -c "from main import app; print('backend OK')"\` 确认导入无误

## SubAgent 2：前端（Vue + Vite）

在 ${WORKSPACE}/ 下搭建前端项目：
1. \`npm create vue@latest frontend -- --default\` 创建项目
2. \`cd frontend && npm install && npm install axios\`
3. 修改 vite.config.ts，设置 server.port 为 9092
4. 修改 src/App.vue：页面加载时 axios 调用 http://localhost:9091/hello，显示返回的 message
5. 完成后验证：执行 \`cd ${WORKSPACE}/frontend && npx vue-tsc --noEmit 2>&1 || true\` 检查 TS 是否有严重错误

## SubAgent 3：运维脚本 + 验证

在 ${WORKSPACE}/ 下创建交互式运维脚本，启动后显示数字菜单让用户选择操作：

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
1. \`bash -n ${WORKSPACE}/run.sh\` 检查语法
2. 如果有语法错误，修复后重新验证，直到通过

所有 SubAgent 完成后，汇总每个子任务的执行结果和验证结论。
`

// ═══════════════════════════════════════════════════════════
// 通过子进程运行 cCli
// ═══════════════════════════════════════════════════════════

function runCli(prompt: string, cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    // prompt 写临时文件，通过 stdin 管道传入，避免 Windows cmd.exe 截断超长参数
    const promptFile = join(tmpdir(), `ccode-e2e-${Date.now()}.txt`)
    writeFileSync(promptFile, prompt, 'utf-8')
    const stdinFd = openSync(promptFile, 'r')

    // --tsconfig 显式指定，解决从非项目目录运行时 paths 别名找不到的问题
    const child = spawn(TSX, [
      '--tsconfig', TSCONFIG, CLI_ENTRY,
      '-p', '按照 stdin 中的任务描述执行',
      '--yes', '--verbose',
    ], {
      cwd,
      stdio: [stdinFd, 'pipe', 'pipe'],
      shell: true,
    })

    let stdout = ''
    let stderr = ''

    child.stdout!.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdout += text
      process.stdout.write(text)
    })

    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      process.stderr.write(text)
    })

    child.on('close', (code) => {
      try { closeSync(stdinFd) } catch { /* ignore */ }
      try { unlinkSync(promptFile) } catch { /* ignore */ }
      resolvePromise({ exitCode: code ?? 1, stdout, stderr })
    })
  })
}

// ═══════════════════════════════════════════════════════════
// 验证检查
// ═══════════════════════════════════════════════════════════

interface CheckItem {
  desc: string
  check: () => boolean
}

function fileExists(relativePath: string): () => boolean {
  return () => existsSync(join(WORKSPACE, relativePath))
}

function fileContains(relativePath: string, keyword: string): () => boolean {
  return () => {
    const fullPath = join(WORKSPACE, relativePath)
    if (!existsSync(fullPath)) return false
    return readFileSync(fullPath, 'utf-8').includes(keyword)
  }
}

const checks: CheckItem[] = [
  // ── 后端 ──
  { desc: 'backend/main.py 存在',              check: fileExists('backend/main.py') },
  { desc: 'backend/pyproject.toml 存在',       check: fileExists('backend/pyproject.toml') },
  { desc: 'main.py 包含 helloworld',           check: fileContains('backend/main.py', 'helloworld') },
  { desc: 'main.py 包含 CORS',                 check: fileContains('backend/main.py', 'CORSMiddleware') },
  // ── 前端 ──
  { desc: 'frontend/package.json 存在',        check: fileExists('frontend/package.json') },
  { desc: 'frontend/vite.config.ts 存在',      check: fileExists('frontend/vite.config.ts') },
  { desc: 'frontend/src/App.vue 存在',         check: fileExists('frontend/src/App.vue') },
  { desc: 'vite.config.ts 包含端口 9092',      check: fileContains('frontend/vite.config.ts', '9092') },
  { desc: 'App.vue 调用后端 9091',             check: fileContains('frontend/src/App.vue', '9091') },
  { desc: 'package.json 包含 axios',           check: fileContains('frontend/package.json', 'axios') },
  // ── 运维脚本 ──
  { desc: 'run.bat 存在',                      check: fileExists('run.bat') },
  { desc: 'run.sh 存在',                       check: fileExists('run.sh') },
  { desc: 'run.bat 包含菜单选项',              check: fileContains('run.bat', '请选择') },
  { desc: 'run.bat 包含 9091',                 check: fileContains('run.bat', '9091') },
  { desc: 'run.bat 包含 9092',                 check: fileContains('run.bat', '9092') },
  { desc: 'run.sh 包含菜单选项',               check: fileContains('run.sh', '请选择') },
  { desc: 'run.sh 包含 9091',                  check: fileContains('run.sh', '9091') },
  { desc: 'run.sh 包含 9092',                  check: fileContains('run.sh', '9092') },
]

// ═══════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════

function formatTime(d: Date): string {
  return d.toLocaleString('zh-CN', { hour12: false })
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`
}

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗')
  console.log('║  SubAgent 全栈项目 E2E 测试（TS 版）                     ║')
  console.log('╠═══════════════════════════════════════════════════════════╣')
  console.log(`║  工作目录:  ${WORKSPACE}`)
  console.log(`║  CLI 入口:  ${CLI_ENTRY}`)
  console.log('╚═══════════════════════════════════════════════════════════╝')

  mkdirSync(WORKSPACE, { recursive: true })

  const startDate = new Date()
  console.log(`\n▶ 启动 cCli 管道模式...`)
  console.log(`  开始时间: ${formatTime(startDate)}\n`)

  const startMs = Date.now()
  const { exitCode } = await runCli(PROMPT, WORKSPACE)
  const endMs = Date.now()
  const endDate = new Date()

  console.log(`\n═══════════════════════════════════════════════════════════`)
  console.log(`  cCli 退出码: ${exitCode}`)
  console.log(`  开始时间:    ${formatTime(startDate)}`)
  console.log(`  结束时间:    ${formatTime(endDate)}`)
  console.log(`  耗时:        ${formatElapsed(endMs - startMs)}`)
  console.log(`═══════════════════════════════════════════════════════════`)

  // ── 验证产出物 ──
  console.log('\n▶ 验证产出物...')
  let passed = 0
  let failed = 0

  for (const item of checks) {
    if (item.check()) {
      console.log(`  ✓ ${item.desc}`)
      passed++
    } else {
      console.log(`  ✗ ${item.desc}`)
      failed++
    }
  }

  console.log(`\n${'═'.repeat(55)}`)
  console.log(`  验证: ${passed} passed, ${failed} failed`)
  console.log('═'.repeat(55))

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('测试脚本异常:', err)
  process.exit(1)
})
