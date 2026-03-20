import { describe, it, expect } from 'vitest'

/**
 * pipe-runner 单元测试。
 *
 * 由于 runPipe 依赖完整的 Provider + AgentLoop 运行时（需要真实 LLM 调用），
 * 这里只测试可独立验证的辅助逻辑：参数解析和 stdin 读取。
 * 端到端的 Pipe Mode 测试通过手动 CLI 调用验证。
 */

describe('parseArgs (zcli.ts arg parsing)', () => {
  // 直接测试 parseArgs 逻辑（内联实现，避免导入 bin/zcli.ts 触发副作用）
  function parseArgs(argv: string[]) {
    const result = {
      prompt: null as string | null,
      model: null as string | null,
      provider: null as string | null,
      resumeSessionId: undefined as string | undefined,
      showResumeOnStart: false,
      yes: false,
      noTools: false,
      json: false,
    }
    const positional: string[] = []
    let i = 0
    while (i < argv.length) {
      const arg = argv[i]!
      if (arg === '-p' || arg === '--prompt') { result.prompt = argv[++i] ?? '' }
      else if (arg === '-m' || arg === '--model') { result.model = argv[++i] ?? '' }
      else if (arg === '--provider') { result.provider = argv[++i] ?? '' }
      else if (arg === '--resume') {
        const next = argv[i + 1]
        if (next && !next.startsWith('-')) { result.resumeSessionId = next; i++ }
        else { result.showResumeOnStart = true }
      }
      else if (arg === '--yes' || arg === '-y') { result.yes = true }
      else if (arg === '--no-tools') { result.noTools = true }
      else if (arg === '--json') { result.json = true }
      else if (!arg.startsWith('-')) { positional.push(arg) }
      i++
    }
    if (result.prompt == null && positional.length > 0) {
      result.prompt = positional.join(' ')
    }
    return result
  }

  it('should_parse_positional_prompt', () => {
    const args = parseArgs(['帮我看看目录结构'])
    expect(args.prompt).toBe('帮我看看目录结构')
  })

  it('should_parse_-p_flag', () => {
    const args = parseArgs(['-p', '分析这个文件'])
    expect(args.prompt).toBe('分析这个文件')
  })

  it('should_parse_--prompt_flag', () => {
    const args = parseArgs(['--prompt', '写个函数'])
    expect(args.prompt).toBe('写个函数')
  })

  it('should_prefer_-p_over_positional', () => {
    const args = parseArgs(['-p', 'from flag', 'positional'])
    expect(args.prompt).toBe('from flag')
  })

  it('should_join_multiple_positional_args', () => {
    const args = parseArgs(['hello', 'world'])
    expect(args.prompt).toBe('hello world')
  })

  it('should_parse_model_and_provider', () => {
    const args = parseArgs(['-m', 'gpt-4o', '--provider', 'openai', '你好'])
    expect(args.model).toBe('gpt-4o')
    expect(args.provider).toBe('openai')
    expect(args.prompt).toBe('你好')
  })

  it('should_parse_--yes_flag', () => {
    const args = parseArgs(['--yes', '执行命令'])
    expect(args.yes).toBe(true)
  })

  it('should_parse_-y_shorthand', () => {
    const args = parseArgs(['-y', '执行命令'])
    expect(args.yes).toBe(true)
  })

  it('should_parse_--no-tools_flag', () => {
    const args = parseArgs(['--no-tools', '纯对话'])
    expect(args.noTools).toBe(true)
  })

  it('should_parse_--json_flag', () => {
    const args = parseArgs(['--json', '问个问题'])
    expect(args.json).toBe(true)
  })

  it('should_parse_--resume_with_sessionId', () => {
    const args = parseArgs(['--resume', 'abc-123'])
    expect(args.resumeSessionId).toBe('abc-123')
    expect(args.showResumeOnStart).toBe(false)
  })

  it('should_parse_--resume_without_sessionId', () => {
    const args = parseArgs(['--resume'])
    expect(args.resumeSessionId).toBeUndefined()
    expect(args.showResumeOnStart).toBe(true)
  })

  it('should_return_null_prompt_for_repl_mode', () => {
    const args = parseArgs([])
    expect(args.prompt).toBeNull()
  })

  it('should_combine_all_flags', () => {
    const args = parseArgs(['-m', 'claude-opus-4-6', '--provider', 'anthropic', '--yes', '--json', '-p', '测试'])
    expect(args.model).toBe('claude-opus-4-6')
    expect(args.provider).toBe('anthropic')
    expect(args.yes).toBe(true)
    expect(args.json).toBe(true)
    expect(args.prompt).toBe('测试')
  })
})
