// src/core/pipe-runner.ts

/**
 * PipeRunner — 非交互模式执行器。
 *
 * 不启动 React/Ink，直接驱动 AgentLoop，纯文本输出到 stdout。
 * 支持：
 * - 位置参数 / -p 传入 prompt
 * - stdin 管道输入作为上下文前缀
 * - --yes 自动批准工具执行
 * - --json 结构化输出
 * - --no-tools 禁用工具调用
 */

import { buildArgsSummary } from '@ui/ToolStatusLine.js'
import { formatDuration } from '@ui/format-utils.js'
import { configManager } from '@config/config-manager.js'
import { createProvider } from '@providers/registry.js'
import { AgentLoop } from './agent-loop.js'
import type { Message } from './types.js'
import {
  sessionLogger, tokenMeter,
  getRegistry, ensureMcpInitialized, registerMcpTools,
  hookManager,
  getSystemPrompt,
  bootstrapAll,
} from './bootstrap.js'
import { PermissionManager } from '@config/permissions.js'
import { closeDb } from '@persistence/index.js'

export interface PipeOptions {
  prompt: string
  /** stdin 管道读取到的内容（为空表示无管道输入） */
  stdinContent?: string | undefined
  model?: string | undefined
  provider?: string | undefined
  /** 自动批准所有工具执行 */
  yes?: boolean | undefined
  /** 禁用工具调用 */
  noTools?: boolean | undefined
  /** JSON 格式输出 */
  json?: boolean | undefined
  /** 在 stderr 输出工具执行进度 */
  verbose?: boolean | undefined
}

export async function runPipe(options: PipeOptions): Promise<void> {
  const config = configManager.load()
  const providerName = options.provider ?? config.defaultProvider ?? ''
  const modelName = options.model ?? config.defaultModel ?? ''

  const provider = createProvider(providerName, config)
  const registry = getRegistry()

  // 构建用户消息：stdin 内容 + prompt
  let userContent = options.prompt
  if (options.stdinContent) {
    userContent = `<stdin>\n${options.stdinContent}\n</stdin>\n\n${options.prompt}`
  }

  const history: Message[] = [{ role: 'user', content: userContent }]

  // 初始化 session 和 observability
  const sid = sessionLogger.ensureSession(providerName, modelName)
  if (sid) tokenMeter.bind(sid, providerName, modelName)
  sessionLogger.logUserMessage(userContent)

  // 统一启动编排 + MCP（Pipe 模式一次性执行，必须等 MCP 就绪）
  await Promise.all([
    bootstrapAll(),
    options.noTools ? Promise.resolve() : ensureMcpInitialized(),
  ])
  if (!options.noTools) {
    registerMcpTools(registry)
  }
  const systemPrompt = getSystemPrompt()

  const controller = new AbortController()

  // SIGINT 时优雅退出
  const onSigint = () => { controller.abort() }
  process.on('SIGINT', onSigint)

  const loop = new AgentLoop(provider, options.noTools ? getRegistry() : registry, {
    model: modelName,
    provider: providerName,
    signal: controller.signal,
    nonInteractive: true,
    hookManager,
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(sid ? { sessionId: sid } : {}),
  })

  let accumulated = ''
  let exitCode = 0

  try {
    for await (const event of loop.run(history)) {
      // observability
      sessionLogger.consume(event)
      tokenMeter.consume(event)

      if (event.type === 'text') {
        accumulated += event.text
        // 非 JSON 模式下实时流式输出
        if (!options.json) {
          process.stdout.write(event.text)
        }
      } else if (event.type === 'tool_start' && options.verbose) {
        // --verbose: 在 stderr 输出工具进度（不污染 stdout 管道数据）
        const summary = buildArgsSummary(event.toolName, event.args)
        process.stderr.write(`[tool] ${event.toolName}: ${summary}...`)
      } else if (event.type === 'tool_done' && options.verbose) {
        const icon = event.success ? '✓' : '✗'
        const duration = formatDuration(event.durationMs)
        const meta = event.resultSummary ? `  ${event.resultSummary.split('\n')[0]!.slice(0, 60)}` : ''
        process.stderr.write(` ${icon}${meta}  ${duration}\n`)
      } else if (event.type === 'permission_request') {
        // 权限检查：项目级白名单 → --yes 全部放行 → 拒绝
        const toolNames = registry.getAll().map(t => t.name)
        const pm = PermissionManager.fromProjectDir(process.cwd(), toolNames)
        if (pm.isAllowed(event.toolName)) {
          event.resolve(true)
        } else {
          event.resolve(options.yes === true)
        }
      } else if (event.type === 'error') {
        exitCode = 1
        if (!options.json) {
          process.stderr.write(`Error: ${event.error}\n`)
        }
        break
      } else if (event.type === 'done') {
        break
      }
    }

    // 记录助手回复
    if (accumulated) {
      sessionLogger.logAssistantMessage(accumulated, modelName)
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') {
      exitCode = 1
      const msg = err instanceof Error ? err.message : String(err)
      if (!options.json) {
        process.stderr.write(`Error: ${msg}\n`)
      }
    }
  } finally {
    process.off('SIGINT', onSigint)
  }

  // JSON 模式：一次性输出结构化数据
  if (options.json) {
    const stats = tokenMeter.getSessionStats()
    const costEntries = Object.entries(stats.costByCurrency).filter(([, v]) => v > 0)
    const output = {
      response: accumulated,
      model: modelName,
      provider: providerName,
      usage: {
        inputTokens: stats.totalInputTokens,
        outputTokens: stats.totalOutputTokens,
        cacheReadTokens: stats.totalCacheReadTokens,
        cacheWriteTokens: stats.totalCacheWriteTokens,
        cost: costEntries.length > 0 ? Object.fromEntries(costEntries) : null,
      },
      exitCode,
    }
    process.stdout.write(JSON.stringify(output, null, 2) + '\n')
  } else if (accumulated && !accumulated.endsWith('\n')) {
    // 确保输出以换行结尾
    process.stdout.write('\n')
  }

  // 清理
  sessionLogger.finalize()
  closeDb()

  process.exit(exitCode)
}

/** 从 stdin 读取管道内容（非 TTY 时） */
export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('')
      return
    }
    const chunks: Buffer[] = []
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    process.stdin.resume()
  })
}
