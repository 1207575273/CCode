import { describe, it, expect } from 'vitest'
import { HookRunner } from '../../../src/hooks/hook-runner.js'

describe('HookRunner', () => {
  const runner = new HookRunner()
  const cwd = process.cwd()

  it('should parse JSON stdout when command succeeds', async () => {
    const result = await runner.run({
      command: 'echo \'{"status":"ok","count":42}\'',
      cwd,
      env: {},
      timeout: 5000,
    })
    expect(result).toEqual({ status: 'ok', count: 42 })
  })

  it('should return null when stdout is not valid JSON', async () => {
    const result = await runner.run({
      command: 'echo "hello world"',
      cwd,
      env: {},
      timeout: 5000,
    })
    expect(result).toBeNull()
  })

  it('should return null when command exits with non-zero code', async () => {
    const result = await runner.run({
      command: 'exit 1',
      cwd,
      env: {},
      timeout: 5000,
    })
    expect(result).toBeNull()
  })

  it('should return null when command times out', async () => {
    const result = await runner.run({
      command: 'sleep 10',
      cwd,
      env: {},
      timeout: 500,
    })
    expect(result).toBeNull()
  }, 10000)

  it('should pass stdin data to the command', async () => {
    // bash read 从 stdin 读取，然后用 jq 风格手动构造 JSON
    const result = await runner.run({
      command: 'read -r line; echo "{\\\"input\\\":\\\"$line\\\"}"',
      cwd,
      env: {},
      timeout: 5000,
      stdin: 'hello-from-stdin',
    })
    expect(result).toEqual({ input: 'hello-from-stdin' })
  })

  it('should pass extra environment variables to the command', async () => {
    const result = await runner.run({
      command: 'echo "{\\\"val\\\":\\\"$MY_HOOK_VAR\\\"}"',
      cwd,
      env: { MY_HOOK_VAR: 'test-value' },
      timeout: 5000,
    })
    expect(result).toEqual({ val: 'test-value' })
  })
})
