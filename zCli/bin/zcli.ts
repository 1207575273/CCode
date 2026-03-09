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

function exitGracefully() {
  unmount()
  const sessionId = getCurrentSessionId()
  if (sessionId) {
    console.log(`\nResume this session with:\n  zcli --resume ${sessionId}\n`)
  }
  process.exit(0)
}

process.on('SIGINT', exitGracefully)
