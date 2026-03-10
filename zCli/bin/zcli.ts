// bin/zcli.ts
import React from 'react'
import { render } from 'ink'
import { App } from '../src/ui/App.js'
import { getCurrentSessionId, sessionLogger } from '../src/ui/useChat.js'
import { closeDb } from '../src/persistence/index.js'

// Simple argument parsing (no external deps)
const args = process.argv.slice(2)
const resumeIndex = args.indexOf('--resume')
let resumeSessionId: string | undefined
let showResumeOnStart = false

if (resumeIndex !== -1) {
  const nextArg = args[resumeIndex + 1]
  if (nextArg && !nextArg.startsWith('--')) {
    resumeSessionId = nextArg
  } else {
    showResumeOnStart = true
  }
}

const { unmount } = render(
  React.createElement(App, { resumeSessionId, showResumeOnStart })
)

/** 检测启动方式，生成对应的 resume 命令 */
function getResumeCommand(sessionId: string): string {
  // 通过 `zcli` 全局命令启动时，argv[1] 是 dist/bin/zcli.js
  const entry = process.argv[1] ?? ''
  if (entry.endsWith('zcli.js') || entry.endsWith('zcli')) {
    return `zcli --resume ${sessionId}`
  }
  // 开发模式 (tsx bin/zcli.ts)
  return `pnpm dev -- --resume ${sessionId}`
}

/** 打印 resume 提示（幂等，只打印一次） */
let resumeHintPrinted = false
function printResumeHint(): void {
  if (resumeHintPrinted) return
  resumeHintPrinted = true
  const sessionId = getCurrentSessionId()
  if (sessionId) {
    const cmd = getResumeCommand(sessionId)
    // 使用 process.stdout.write 确保同步写入（exit handler 中 console.log 可能丢失）
    process.stdout.write(`\nResume this session with:\n  ${cmd}\n\n`)
  }
}

function exitGracefully() {
  // F9: 写入 session_end 汇总事件
  sessionLogger.finalize()
  // F10: 关闭 SQLite 连接
  closeDb()
  unmount()
  printResumeHint()
  process.exit(0)
}

process.on('SIGINT', exitGracefully)
// 兜底：无论以何种方式退出（Ink 内部 exit、process.exit 等），都打印 resume 提示
process.on('exit', printResumeHint)
