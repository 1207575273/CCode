// tests/unit/a2a/a2a-command.test.ts

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { A2aCommand } from '@commands/a2a.js'
import type { TrustedAgent } from '../../../src/a2a/types.js'

function tmpFile(): string {
  return join(tmpdir(), `a2a-cmd-${randomUUID()}.json`)
}

const created: string[] = []
function track(p: string): string {
  created.push(p)
  return p
}

afterEach(() => {
  for (const p of created.splice(0)) {
    if (existsSync(p)) rmSync(p, { force: true })
  }
})

function readFile(p: string): TrustedAgent[] {
  return JSON.parse(readFileSync(p, 'utf-8')) as TrustedAgent[]
}

describe('A2aCommand', () => {
  it('should_show_empty_hint_when_no_trusted_agents', () => {
    const cmd = new A2aCommand(track(tmpFile()))
    const res = cmd.execute(['list'])
    expect(res.handled).toBe(true)
    expect(res.action?.type).toBe('show_help')
    expect((res.action as { content: string }).content).toContain('暂无已信任')
  })

  it('should_default_to_list_when_no_subcommand', () => {
    const cmd = new A2aCommand(track(tmpFile()))
    const res = cmd.execute([])
    expect(res.action?.type).toBe('show_help')
  })

  it('should_add_agent_and_persist_to_file', () => {
    const file = track(tmpFile())
    const cmd = new A2aCommand(file)
    const res = cmd.execute(['add', 'https://remote.example.com', 'sales'])
    expect(res.action?.type).toBe('show_help')

    const list = readFile(file)
    expect(list).toHaveLength(1)
    expect(list[0]!.url).toBe('https://remote.example.com')
    expect(list[0]!.alias).toBe('sales')
    expect(list[0]!.securityScheme).toBe('none')
    expect(list[0]!.id).toBeTruthy()
  })

  it('should_reject_add_when_url_invalid', () => {
    const cmd = new A2aCommand(track(tmpFile()))
    const res = cmd.execute(['add', 'not-a-url'])
    expect(res.action?.type).toBe('error')
    expect((res.action as { message: string }).message).toContain('http')
  })

  it('should_reject_add_when_url_missing', () => {
    const cmd = new A2aCommand(track(tmpFile()))
    const res = cmd.execute(['add'])
    expect(res.action?.type).toBe('error')
  })

  it('should_dedupe_when_same_url_added_twice', () => {
    const file = track(tmpFile())
    const cmd = new A2aCommand(file)
    cmd.execute(['add', 'https://x.com', 'first'])
    cmd.execute(['add', 'https://x.com', 'second'])
    const list = readFile(file)
    expect(list).toHaveLength(1)
    expect(list[0]!.alias).toBe('second')
  })

  it('should_list_added_agents_with_masked_token', () => {
    const file = track(tmpFile())
    const cmd = new A2aCommand(file)
    cmd.execute(['add', 'https://x.com', 'myagent'])
    const res = cmd.execute(['list'])
    const content = (res.action as { content: string }).content
    expect(content).toContain('myagent')
    expect(content).toContain('https://x.com')
  })

  it('should_remove_agent_by_url', () => {
    const file = track(tmpFile())
    const cmd = new A2aCommand(file)
    cmd.execute(['add', 'https://x.com', 'a'])
    const res = cmd.execute(['remove', 'https://x.com'])
    expect(res.action?.type).toBe('show_help')
    expect(readFile(file)).toHaveLength(0)
  })

  it('should_remove_agent_by_alias', () => {
    const file = track(tmpFile())
    const cmd = new A2aCommand(file)
    cmd.execute(['add', 'https://x.com', 'myalias'])
    const res = cmd.execute(['remove', 'myalias'])
    expect(res.action?.type).toBe('show_help')
    expect(readFile(file)).toHaveLength(0)
  })

  it('should_error_when_remove_target_not_found', () => {
    const cmd = new A2aCommand(track(tmpFile()))
    const res = cmd.execute(['remove', 'nonexistent'])
    expect(res.action?.type).toBe('error')
  })
})
