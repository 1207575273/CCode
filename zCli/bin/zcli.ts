// bin/zcli.ts
import React from 'react'
import { render } from 'ink'
import { App } from '../src/ui/App.js'
import { getCurrentSessionId } from '../src/ui/useChat.js'

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

function exitGracefully() {
  unmount()
  const sessionId = getCurrentSessionId()
  if (sessionId) {
    const cmd = getResumeCommand(sessionId)
    console.log(`\nResume this session with:\n  ${cmd}\n`)
  }
  process.exit(0)
}

process.on('SIGINT', exitGracefully)
