// bin/ccli.ts

/**
 * cCli 入口 — 根据参数判断运行模式：
 *
 * 1. 非交互模式（Pipe Mode）：有 prompt 时直接执行，纯文本输出，执行完退出
 *    - ccode "问题"
 *    - ccode -p "问题"
 *    - cat file | ccode "分析一下"
 *
 * 2. 交互模式（REPL）：无 prompt 时启动 Ink 界面
 *    - ccode
 *    - ccode --resume
 *    - ccode --resume <sessionId>
 */

import { runPipe, readStdin } from '../src/core/pipe-runner.js'
import { initialize } from '../src/core/initializer.js'
import { isSensitiveDirectory, confirmWorkspaceTrust } from '../src/core/workspace-trust.js'

// 过滤 Node.js 内部警告，不泄露到用户终端
process.on('warning', (warning) => {
  if (warning.name === 'MaxListenersExceededWarning') return
})

// ═══ 启动初始化 ═══
const initResult = initialize()
if (initResult.created.length > 0) {
  process.stderr.write(`[init] 已创建: ${initResult.created.join(', ')}\n`)
}
for (const warn of initResult.warnings) {
  process.stderr.write(`[init] ⚠ ${warn}\n`)
}

// ═══ 参数解析（无外部依赖） ═══

interface CliArgs {
  prompt: string | null
  model: string | null
  provider: string | null
  resumeSessionId: string | undefined
  showResumeOnStart: boolean
  yes: boolean
  noTools: boolean
  json: boolean
  verbose: boolean
  web: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = {
    prompt: null, model: null, provider: null,
    resumeSessionId: undefined, showResumeOnStart: false,
    yes: false, noTools: false, json: false, verbose: false, web: false,
  }

  const positional: string[] = []
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]!
    if (arg === '-p' || arg === '--prompt') {
      result.prompt = argv[++i] ?? ''
    } else if (arg === '-m' || arg === '--model') {
      result.model = argv[++i] ?? ''
    } else if (arg === '--provider') {
      result.provider = argv[++i] ?? ''
    } else if (arg === '--resume') {
      const next = argv[i + 1]
      if (next && !next.startsWith('-')) {
        result.resumeSessionId = next
        i++
      } else {
        result.showResumeOnStart = true
      }
    } else if (arg === '--yes' || arg === '-y') {
      result.yes = true
    } else if (arg === '--no-tools') {
      result.noTools = true
    } else if (arg === '--json') {
      result.json = true
    } else if (arg === '--verbose' || arg === '-v') {
      result.verbose = true
    } else if (arg === '--web') {
      result.web = true
    } else if (!arg.startsWith('-')) {
      positional.push(arg)
    }
    i++
  }

  // 位置参数作为 prompt（-p 优先）
  if (result.prompt == null && positional.length > 0) {
    result.prompt = positional.join(' ')
  }

  return result
}

const args = parseArgs(process.argv.slice(2))

// ═══ 模式判断 ═══

if (args.prompt != null) {
  // 非交互模式：有 prompt → 直接执行
  const stdinContent = await readStdin()
  await runPipe({
    prompt: args.prompt,
    stdinContent: stdinContent || undefined,
    model: args.model ?? undefined,
    provider: args.provider ?? undefined,
    yes: args.yes,
    noTools: args.noTools,
    json: args.json,
    verbose: args.verbose,
  })
} else {
  // 敏感目录信任确认（用户主目录、根目录等）
  if (isSensitiveDirectory(process.cwd())) {
    const trusted = await confirmWorkspaceTrust(process.cwd())
    if (!trusted) process.exit(0)
  }

  // 交互模式：并行加载所有模块（6 个 dynamic import 同时解析，不串行等待）
  const [
    React,
    { render },
    { App },
    { getCurrentSessionId, sessionLogger },
    { closeDb },
    { leaveAlternateScreen },
    { stopFileWatcher },
  ] = await Promise.all([
    import('react'),
    import('ink'),
    import('../src/ui/App.js'),
    import('../src/ui/useChat.js'),
    import('../src/persistence/index.js'),
    import('../src/ui/terminal-screen.js'),
    import('../src/core/bootstrap.js'),
  ])

  // 若指定 --web 则启动/连接 Bridge Server
  if (args.web) {
    const { startBridgeServer, connectBridge, disconnectBridge, closeBridge } = await import('../src/server/bridge/index.js')

    // 检测端口是否已被占用
    const { createServer: createNetServer } = await import('node:net')
    const portInUse = await new Promise<boolean>((resolve) => {
      const tester = createNetServer()
      tester.once('error', () => resolve(true))
      tester.once('listening', () => { tester.close(); resolve(false) })
      tester.listen(9800)
    })

    // 标记当前实例是否是 Bridge Server 的启动者
    let isBridgeOwner = false
    // 实际绑定的端口（可能因端口冲突自动递增，如 9800→9801）
    let bridgePort = 9800

    if (!portInUse) {
      // 第一个 CLI：启动 Bridge Server + Vite
      const isDevMode = (process.argv[1] ?? '').endsWith('.ts')
      let vitePort: number | undefined

      if (isDevMode) {
        // 动态分配空闲端口给 Vite（避免与用户项目的 5173 冲突）
        const { createServer: createNetServer2 } = await import('node:net')
        vitePort = await new Promise<number>((resolve, reject) => {
          const srv = createNetServer2()
          srv.listen(0, () => {
            const addr = srv.address()
            const port = typeof addr === 'object' && addr ? addr.port : 0
            srv.close(() => resolve(port))
          })
          srv.on('error', reject)
        })

        const { execa } = await import('execa')
        const webDir = new URL('../web', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
        const viteProcess = execa('npx', ['vite', '--port', String(vitePort)], { cwd: webDir, stdio: 'ignore' })
        viteProcess.catch(() => { /* Vite 退出时静默 */ })
        process.on('exit', () => { viteProcess.kill() })

        // 等 Vite 就绪（轮询端口，最多 15 秒）
        const { createConnection } = await import('node:net')
        const viteReady = await new Promise<boolean>((resolve) => {
          let attempts = 0
          const maxAttempts = 150 // 150 × 100ms = 15s
          const poll = () => {
            const sock = createConnection({ port: vitePort! }, () => {
              sock.destroy()
              resolve(true)
            })
            sock.on('error', () => {
              sock.destroy()
              if (++attempts < maxAttempts) setTimeout(poll, 100)
              else resolve(false)
            })
          }
          poll()
        })
        if (!viteReady) {
          // Vite 超时未就绪，不阻塞 CLI 启动，反代时会返回 502
          // 但几乎不会发生（Vite 冷启动通常 < 3 秒）
        }
      }

      const bridge = startBridgeServer({
        dev: isDevMode,
        ...(vitePort !== undefined ? { vitePort } : {}),
      })
      bridgePort = bridge.port
      isBridgeOwner = true
    }

    // 所有 CLI（包括第一个）都作为 WS 客户端连接 Bridge
    // render 后才有 sessionId（useChat mount 时创建），轮询等待而非固定延迟
    // 生产模式下 bootstrapAll 耗时可能超过 100ms，固定延迟会导致 sid 为 null
    const waitAndConnect = () => {
      let attempts = 0
      const maxAttempts = 50 // 最多等 5 秒
      const poll = () => {
        const sid = getCurrentSessionId()
        if (sid) {
          connectBridge(bridgePort, sid)
        } else if (++attempts < maxAttempts) {
          setTimeout(poll, 100)
        }
      }
      setTimeout(poll, 100)
    }
    waitAndConnect()

    process.on('exit', () => {
      disconnectBridge()
      // 只有 Bridge Server 的启动者才关闭 server，避免影响其他 CLI 实例
      if (isBridgeOwner) closeBridge()
    })
  }

  const { unmount } = render(
    React.createElement(App, {
      ...(args.resumeSessionId != null ? { resumeSessionId: args.resumeSessionId } : {}),
      ...(args.showResumeOnStart ? { showResumeOnStart: true } : {}),
      ...(args.model != null ? { model: args.model } : {}),
      ...(args.provider != null ? { provider: args.provider } : {}),
      ...(args.web ? { webEnabled: true } : {}),
    }),
    { exitOnCtrlC: false },
  )

  /** 检测启动方式，生成对应的 resume 命令 */
  function getResumeCommand(sessionId: string): string {
    const entry = process.argv[1] ?? ''
    if (entry.endsWith('ccli.js') || entry.endsWith('ccode') || entry.endsWith('ccli')) {
      return `ccode --resume ${sessionId}`
    }
    return `pnpm run dev -- --resume ${sessionId}`
  }

  /** 打印 resume 提示（幂等，只打印一次） */
  let resumeHintPrinted = false
  function printResumeHint(): void {
    if (resumeHintPrinted) return
    resumeHintPrinted = true
    const sessionId = getCurrentSessionId()
    if (sessionId) {
      const cmd = getResumeCommand(sessionId)
      process.stdout.write(`\nResume this session with:\n  ${cmd}\n\n`)
    }
  }

  function exitGracefully() {
    stopFileWatcher()
    sessionLogger.finalize()
    closeDb()
    unmount()
    // 还原主屏幕（如果进入了备用屏幕），必须在 printResumeHint 之前
    leaveAlternateScreen()
    printResumeHint()
    process.exit(0)
  }

  process.on('SIGINT', exitGracefully)
  process.on('exit', () => {
    leaveAlternateScreen()
    printResumeHint()
  })
}
