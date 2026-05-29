// tests/unit/a2a/a2a-config.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

// 被测模块（测试先写，文件尚不存在 -> RED）
import { A2ATrustStore, maskToken } from '@config/a2a-config.js'

// 每个测试独立临时文件，afterEach 清理
function makeTmpFile(): string {
  return join(tmpdir(), `a2a-trust-${randomUUID()}.json`)
}

const cleanupFiles: string[] = []

afterEach(async () => {
  for (const f of cleanupFiles.splice(0)) {
    await rm(f, { force: true })
  }
})

// ─────────────────────────────────────────────
// Case 1：load 文件不存在时返回空数组（不抛异常）
// ─────────────────────────────────────────────
describe('A2ATrustStore.load', () => {
  it('should_return_empty_array_when_file_does_not_exist', async () => {
    const file = makeTmpFile()
    cleanupFiles.push(file)

    const store = new A2ATrustStore(file)
    const result = await store.load()

    expect(result).toEqual([])
  })
})

// ─────────────────────────────────────────────
// Case 2：add 生成 id + addedAt，list 可读到
// ─────────────────────────────────────────────
describe('A2ATrustStore.add', () => {
  it('should_generate_id_and_addedAt_and_be_readable_via_list', async () => {
    const file = makeTmpFile()
    cleanupFiles.push(file)

    const store = new A2ATrustStore(file)
    const agent = await store.add({
      url: 'https://agent.example.com',
      name: 'TestAgent',
      securityScheme: 'none',
    })

    // id 是 UUID 格式
    expect(agent.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    // addedAt 是 ISO 字符串
    expect(() => new Date(agent.addedAt)).not.toThrow()
    expect(new Date(agent.addedAt).toISOString()).toBe(agent.addedAt)

    // list 能读到该条目
    const list = await store.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.url).toBe('https://agent.example.com')
    expect(list[0]!.name).toBe('TestAgent')
  })
})

// ─────────────────────────────────────────────
// Case 3：add 同 url 两次只保留一条（覆盖更新）
// ─────────────────────────────────────────────
describe('A2ATrustStore.add url dedup', () => {
  it('should_keep_only_one_entry_when_same_url_added_twice', async () => {
    const file = makeTmpFile()
    cleanupFiles.push(file)

    const store = new A2ATrustStore(file)
    await store.add({ url: 'https://agent.example.com', name: 'AgentV1', securityScheme: 'none' })
    const second = await store.add({
      url: 'https://agent.example.com',
      name: 'AgentV2',
      securityScheme: 'bearer',
      authToken: 'sk-newtoken',
    })

    const list = await store.list()
    expect(list).toHaveLength(1)
    // 覆盖后 name 和 securityScheme 以第二次为准
    expect(list[0]!.name).toBe('AgentV2')
    expect(list[0]!.securityScheme).toBe('bearer')
    // 返回的 id 沿用第一次（已存在条目的 id）
    expect(list[0]!.id).toBe(second.id)
  })
})

// ─────────────────────────────────────────────
// Case 4：remove 存在返回 true / 不存在返回 false
// ─────────────────────────────────────────────
describe('A2ATrustStore.remove', () => {
  it('should_return_true_when_agent_exists_and_false_when_not', async () => {
    const file = makeTmpFile()
    cleanupFiles.push(file)

    const store = new A2ATrustStore(file)
    const agent = await store.add({
      url: 'https://agent.example.com',
      name: 'Agent',
      securityScheme: 'none',
    })

    const removed = await store.remove(agent.id)
    expect(removed).toBe(true)

    const listAfter = await store.list()
    expect(listAfter).toHaveLength(0)

    const removedAgain = await store.remove(agent.id)
    expect(removedAgain).toBe(false)
  })
})

// ─────────────────────────────────────────────
// Case 5：findByUrl 命中 / 未命中
// ─────────────────────────────────────────────
describe('A2ATrustStore.findByUrl', () => {
  it('should_return_agent_when_url_matches', async () => {
    const file = makeTmpFile()
    cleanupFiles.push(file)

    const store = new A2ATrustStore(file)
    await store.add({ url: 'https://found.example.com', name: 'Found', securityScheme: 'none' })

    const found = await store.findByUrl('https://found.example.com')
    expect(found).toBeDefined()
    expect(found!.name).toBe('Found')
  })

  it('should_return_undefined_when_url_not_in_list', async () => {
    const file = makeTmpFile()
    cleanupFiles.push(file)

    const store = new A2ATrustStore(file)
    const notFound = await store.findByUrl('https://not-exist.example.com')
    expect(notFound).toBeUndefined()
  })
})

// ─────────────────────────────────────────────
// Case 6：maskToken 脱敏 / undefined 返回 '(none)'
// ─────────────────────────────────────────────
describe('maskToken', () => {
  it('should_mask_long_token_showing_prefix_and_suffix', () => {
    const masked = maskToken('sk-1234567890abcdef')
    // 格式：sk-1234...cdef（前8+...+后4）
    expect(masked).toMatch(/^.+\.\.\..{4}$/)
    // 明文 token 不能出现在结果中
    expect(masked).not.toBe('sk-1234567890abcdef')
  })

  it('should_return_none_when_token_is_undefined', () => {
    expect(maskToken(undefined)).toBe('(none)')
  })
})
