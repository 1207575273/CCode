// tests/manual/test-task-output.ts
// 手动集成测试：验证 bash 后台运行 + task_output 读取输出
// 运行: npx tsx tests/manual/test-task-output.ts

import { BashTool } from '../../src/tools/core/bash.js'
import { TaskOutputTool } from '../../src/tools/core/task-output.js'
import type { ToolContext } from '../../src/tools/core/types.js'

const ctx: ToolContext = { cwd: process.cwd() }
const bash = new BashTool()
const taskOutput = new TaskOutputTool()

async function main() {
  console.log('=== 1. 启动后台进程 ===')
  const bgResult = await bash.execute({
    command: 'echo hello && sleep 1 && echo world && sleep 1 && echo done',
    run_in_background: true,
  }, ctx)
  console.log(bgResult.output)

  // 从输出中提取 PID
  const pidMatch = bgResult.output.match(/pid: (\d+)/)
  if (!pidMatch) {
    console.error('未能获取 PID')
    process.exit(1)
  }
  const pid = Number(pidMatch[1])
  console.log(`PID: ${pid}\n`)

  // 等 500ms，让 "hello" 输出
  await sleep(500)

  console.log('=== 2. 立即读取（非阻塞）===')
  const r1 = await taskOutput.execute({ pid }, ctx)
  console.log(r1.output)
  console.log()

  console.log('=== 3. 阻塞等待进程结束 ===')
  const r2 = await taskOutput.execute({ pid, block: true, timeout: 10000 }, ctx)
  console.log(r2.output)
  console.log()

  console.log('=== 4. 进程结束后再读一次 ===')
  const r3 = await taskOutput.execute({ pid }, ctx)
  console.log(r3.output)

  console.log('\n✓ 测试完成')
  process.exit(0)
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
