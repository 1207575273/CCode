/**
 * InstanceRegistry 单元测试
 *
 * 测试策略：
 * - 临时目录（os.tmpdir() + randomUUID）隔离每个用例
 * - afterEach 清理临时目录
 * - now / isAlive / hostname / osUser 全部注入，不依赖真实环境
 * - defaultIsAlive 单独用真实 process.kill 验证（case 10）
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, hostname, userInfo } from 'node:os'
import { randomUUID } from 'node:crypto'

import { InstanceRegistry, defaultIsAlive } from '../../../src/a2a/instance-registry.js'
import type { InstanceCard } from '../../../src/a2a/instance-registry.js'

// ─────────────────────────────────────────────────────────────
// 辅助工具
// ─────────────────────────────────────────────────────────────

/** 创建独立临时目录，afterEach 统一清理 */
const dirsToCleanup: string[] = []

function makeTmpDir(): string {
  const dir = join(tmpdir(), `instance-registry-test-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  dirsToCleanup.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirsToCleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 构造最小的 writeSelf 参数（不含 hostname/osUser/startedAt/lastHeartbeat） */
function makeCardInput(
  overrides: Partial<Omit<InstanceCard, 'hostname' | 'osUser' | 'startedAt' | 'lastHeartbeat'>> = {},
): Omit<InstanceCard, 'hostname' | 'osUser' | 'startedAt' | 'lastHeartbeat'> {
  return {
    sessionId: randomUUID(),
    pid: process.pid,
    port: 9000,
    agentCardUrl: 'http://127.0.0.1:9000/.well-known/agent-card.json',
    projectName: 'test-project',
    cwd: '/tmp/project',
    ...overrides,
  }
}

/** 固定时间戳（2025-01-01T00:00:00.000Z） */
const FIXED_TS = 1735689600000

// ─────────────────────────────────────────────────────────────
// Case 1：writeSelf 写出文件且能被另一个实例的 discover 读到
// ─────────────────────────────────────────────────────────────
describe('InstanceRegistry.writeSelf', () => {
  it('should_write_card_file_and_be_discoverable_by_another_registry', () => {
    const dir = makeTmpDir()
    const selfSessionId = randomUUID()
    const otherSessionId = randomUUID()

    // 「自己」写名片
    const selfRegistry = new InstanceRegistry({
      dir,
      now: () => FIXED_TS,
      selfPid: process.pid,
      hostname: hostname(),
      osUser: userInfo().username,
      isAlive: () => true,
    })
    selfRegistry.writeSelf(
      makeCardInput({ sessionId: selfSessionId, pid: process.pid }),
    )

    // 「其他会话」用另一个 pid 写名片，再用第三个 registry 实例 discover
    const otherRegistry = new InstanceRegistry({
      dir,
      now: () => FIXED_TS,
      selfPid: process.pid + 1,
      hostname: hostname(),
      osUser: userInfo().username,
      isAlive: () => true,
    })
    otherRegistry.writeSelf(
      makeCardInput({ sessionId: otherSessionId, pid: process.pid + 1 }),
    )

    // 用第三个 registry（以 selfSessionId 为自己）discover，应能看到 otherSessionId 的名片
    const observerRegistry = new InstanceRegistry({
      dir,
      now: () => FIXED_TS,
      selfPid: process.pid,
      hostname: hostname(),
      osUser: userInfo().username,
      isAlive: () => true,
    })
    const cards = observerRegistry.discover(selfSessionId)

    expect(cards.length).toBeGreaterThanOrEqual(1)
    const found = cards.find(c => c.sessionId === otherSessionId)
    expect(found).toBeDefined()
    expect(found!.port).toBe(9000)
  })
})

// ─────────────────────────────────────────────────────────────
// Case 2：discover 排除自己的 sessionId
// ─────────────────────────────────────────────────────────────
describe('InstanceRegistry.discover excludes self', () => {
  it('should_exclude_self_sessionId_from_discover_results', () => {
    const dir = makeTmpDir()
    const selfSessionId = randomUUID()

    const registry = new InstanceRegistry({
      dir,
      now: () => FIXED_TS,
      selfPid: process.pid,
      hostname: hostname(),
      osUser: userInfo().username,
      isAlive: () => true,
    })
    registry.writeSelf(makeCardInput({ sessionId: selfSessionId }))

    const cards = registry.discover(selfSessionId)

    const selfFound = cards.find(c => c.sessionId === selfSessionId)
    expect(selfFound).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────
// Case 3：discover 过滤掉 hostname 不同的名片
// ─────────────────────────────────────────────────────────────
describe('InstanceRegistry.discover filters hostname', () => {
  it('should_exclude_cards_with_different_hostname', () => {
    const dir = makeTmpDir()
    const foreignSessionId = randomUUID()
    const localSessionId = randomUUID()

    // 写一张外机名片（hostname 不同）
    const foreignRegistry = new InstanceRegistry({
      dir,
      now: () => FIXED_TS,
      selfPid: 9999,
      hostname: 'foreign-host',
      osUser: userInfo().username,
      isAlive: () => true,
    })
    foreignRegistry.writeSelf(
      makeCardInput({ sessionId: foreignSessionId, pid: 9999 }),
    )

    // 写一张本机名片
    const localRegistry = new InstanceRegistry({
      dir,
      now: () => FIXED_TS,
      selfPid: process.pid + 2,
      hostname: 'local-host',
      osUser: userInfo().username,
      isAlive: () => true,
    })
    localRegistry.writeSelf(
      makeCardInput({ sessionId: localSessionId, pid: process.pid + 2 }),
    )

    // 以 local-host 身份 discover，selfSessionId 随机（不排除任何已写名片）
    const observer = new InstanceRegistry({
      dir,
      now: () => FIXED_TS,
      selfPid: process.pid,
      hostname: 'local-host',
      osUser: userInfo().username,
      isAlive: () => true,
    })
    const cards = observer.discover(randomUUID())

    const hostnames = cards.map(c => c.hostname)
    expect(hostnames).not.toContain('foreign-host')
    expect(hostnames).toContain('local-host')
  })
})

// ─────────────────────────────────────────────────────────────
// Case 4：discover 过滤掉 osUser 不同的名片
// ─────────────────────────────────────────────────────────────
describe('InstanceRegistry.discover filters osUser', () => {
  it('should_exclude_cards_with_different_osUser', () => {
    const dir = makeTmpDir()
    const foreignUserSessionId = randomUUID()
    const localUserSessionId = randomUUID()

    // 写一张其他用户名片
    const foreignUserRegistry = new InstanceRegistry({
      dir,
      now: () => FIXED_TS,
      selfPid: 9998,
      hostname: hostname(),
      osUser: 'other-user',
      isAlive: () => true,
    })
    foreignUserRegistry.writeSelf(
      makeCardInput({ sessionId: foreignUserSessionId, pid: 9998 }),
    )

    // 写一张本用户名片
    const localUserRegistry = new InstanceRegistry({
      dir,
      now: () => FIXED_TS,
      selfPid: process.pid + 3,
      hostname: hostname(),
      osUser: 'local-user',
      isAlive: () => true,
    })
    localUserRegistry.writeSelf(
      makeCardInput({ sessionId: localUserSessionId, pid: process.pid + 3 }),
    )

    const observer = new InstanceRegistry({
      dir,
      now: () => FIXED_TS,
      selfPid: process.pid,
      hostname: hostname(),
      osUser: 'local-user',
      isAlive: () => true,
    })
    const cards = observer.discover(randomUUID())

    const users = cards.map(c => c.osUser)
    expect(users).not.toContain('other-user')
    expect(users).toContain('local-user')
  })
})

// ─────────────────────────────────────────────────────────────
// Case 5：心跳过期 + 进程死 -> discover 不返回 + reapOrphans 删除
// ─────────────────────────────────────────────────────────────
describe('InstanceRegistry dead detection', () => {
  it('should_not_discover_and_reap_when_heartbeat_expired_and_process_dead', () => {
    const dir = makeTmpDir()
    const deadSessionId = randomUUID()

    const WRITE_TS = 1000
    const DISCOVER_TS = WRITE_TS + 31_000   // 超过 30s

    // 写名片时用 WRITE_TS
    const writeRegistry = new InstanceRegistry({
      dir,
      now: () => WRITE_TS,
      selfPid: 88888,
      hostname: hostname(),
      osUser: userInfo().username,
      isAlive: () => false,  // 进程死
    })
    writeRegistry.writeSelf(makeCardInput({ sessionId: deadSessionId, pid: 88888 }))

    // discover 时用 DISCOVER_TS（心跳已过期 31s），isAlive=false
    const observerRegistry = new InstanceRegistry({
      dir,
      now: () => DISCOVER_TS,
      selfPid: process.pid,
      hostname: hostname(),
      osUser: userInfo().username,
      isAlive: () => false,
    })

    const cards = observerRegistry.discover(randomUUID())
    expect(cards.find(c => c.sessionId === deadSessionId)).toBeUndefined()

    // reapOrphans 返回被删的 sessionId 列表
    const reaped = observerRegistry.reapOrphans()
    expect(reaped).toContain(deadSessionId)

    // 文件应已被删除
    const filePath = join(dir, `${deadSessionId}.json`)
    expect(existsSync(filePath)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────
// Case 6：心跳过期但进程活 -> 不算死，discover 仍返回
// ─────────────────────────────────────────────────────────────
describe('InstanceRegistry heartbeat expired but process alive', () => {
  it('should_still_discover_when_heartbeat_expired_but_process_alive', () => {
    const dir = makeTmpDir()
    const sessionId = randomUUID()

    const WRITE_TS = 1000
    const DISCOVER_TS = WRITE_TS + 31_000

    const writeRegistry = new InstanceRegistry({
      dir,
      now: () => WRITE_TS,
      selfPid: 77777,
      hostname: hostname(),
      osUser: userInfo().username,
      isAlive: () => true,  // 进程活
    })
    writeRegistry.writeSelf(makeCardInput({ sessionId, pid: 77777 }))

    const observerRegistry = new InstanceRegistry({
      dir,
      now: () => DISCOVER_TS,
      selfPid: process.pid,
      hostname: hostname(),
      osUser: userInfo().username,
      isAlive: () => true,  // 进程活
    })

    const cards = observerRegistry.discover(randomUUID())
    expect(cards.find(c => c.sessionId === sessionId)).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────
// Case 7：心跳新鲜但 isAlive=false -> 不算死，discover 仍返回
// ─────────────────────────────────────────────────────────────
describe('InstanceRegistry fresh heartbeat but process dead', () => {
  it('should_still_discover_when_heartbeat_fresh_even_if_process_dead', () => {
    const dir = makeTmpDir()
    const sessionId = randomUUID()

    const NOW_TS = 1000
    // 同一个时间戳写和 discover，心跳才 0ms，未过期
    const writeRegistry = new InstanceRegistry({
      dir,
      now: () => NOW_TS,
      selfPid: 66666,
      hostname: hostname(),
      osUser: userInfo().username,
      isAlive: () => false,  // 进程死，但心跳新鲜
    })
    writeRegistry.writeSelf(makeCardInput({ sessionId, pid: 66666 }))

    const observerRegistry = new InstanceRegistry({
      dir,
      now: () => NOW_TS,
      selfPid: process.pid,
      hostname: hostname(),
      osUser: userInfo().username,
      isAlive: () => false,
    })

    const cards = observerRegistry.discover(randomUUID())
    expect(cards.find(c => c.sessionId === sessionId)).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────
// Case 8：heartbeat 更新 lastHeartbeat
// ─────────────────────────────────────────────────────────────
describe('InstanceRegistry.heartbeat', () => {
  it('should_update_lastHeartbeat_when_heartbeat_called', () => {
    const dir = makeTmpDir()
    const sessionId = randomUUID()

    const WRITE_TS = 1000
    const BEAT_TS = 5000

    const registry = new InstanceRegistry({
      dir,
      now: () => WRITE_TS,
      selfPid: process.pid,
      hostname: hostname(),
      osUser: userInfo().username,
      isAlive: () => true,
    })
    registry.writeSelf(makeCardInput({ sessionId }))

    // 切换 now 到 BEAT_TS，调用 heartbeat
    const updatedRegistry = new InstanceRegistry({
      dir,
      now: () => BEAT_TS,
      selfPid: process.pid,
      hostname: hostname(),
      osUser: userInfo().username,
      isAlive: () => true,
    })
    updatedRegistry.heartbeat(sessionId)

    // 读文件验证 lastHeartbeat 已更新
    const filePath = join(dir, `${sessionId}.json`)
    const card: InstanceCard = JSON.parse(readFileSync(filePath, 'utf-8')) as InstanceCard
    expect(card.lastHeartbeat).toBe(new Date(BEAT_TS).toISOString())
  })
})

// ─────────────────────────────────────────────────────────────
// Case 9：removeSelf 删除文件
// ─────────────────────────────────────────────────────────────
describe('InstanceRegistry.removeSelf', () => {
  it('should_delete_card_file_when_removeSelf_called', () => {
    const dir = makeTmpDir()
    const sessionId = randomUUID()

    const registry = new InstanceRegistry({
      dir,
      now: () => FIXED_TS,
      selfPid: process.pid,
      hostname: hostname(),
      osUser: userInfo().username,
      isAlive: () => true,
    })
    registry.writeSelf(makeCardInput({ sessionId }))

    const filePath = join(dir, `${sessionId}.json`)
    expect(existsSync(filePath)).toBe(true)

    registry.removeSelf(sessionId)

    expect(existsSync(filePath)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────
// Case 10：defaultIsAlive — 当前进程返回 true，不存在 pid 返回 false
// ─────────────────────────────────────────────────────────────
describe('defaultIsAlive', () => {
  it('should_return_true_for_current_process_pid', () => {
    expect(defaultIsAlive(process.pid)).toBe(true)
  })

  it('should_return_false_for_nonexistent_pid', () => {
    // 2147483646 是极大 pid，实际环境几乎不可能存在
    expect(defaultIsAlive(2147483646)).toBe(false)
  })
})
