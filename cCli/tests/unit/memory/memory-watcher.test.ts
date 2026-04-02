// tests/unit/memory/memory-watcher.test.ts

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryWatcher } from '@memory/core/memory-watcher.js'
import type { MemoryFileChange } from '@memory/core/memory-watcher.js'

/** 等待 debounce 刷新（300ms debounce + 余量） */
const waitFlush = (ms = 600) => new Promise(r => setTimeout(r, ms))

let watcher: MemoryWatcher | null = null

afterEach(() => {
  watcher?.stop()
  watcher = null
})

describe('MemoryWatcher', () => {
  it('should_detect_new_md_file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memwatch-'))
    const changes: MemoryFileChange[] = []
    watcher = new MemoryWatcher(c => changes.push(...c))
    watcher.start([{ path: dir, scope: 'project' }])

    // 写入新文件
    writeFileSync(join(dir, 'test.md'), '# Test')
    await waitFlush()

    expect(changes.length).toBeGreaterThan(0)
    expect(changes.some(c => c.filePath.includes('test.md'))).toBe(true)
    expect(changes[0]!.scope).toBe('project')
  })

  it('should_ignore_non_md_files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memwatch-'))
    const changes: MemoryFileChange[] = []
    watcher = new MemoryWatcher(c => changes.push(...c))
    watcher.start([{ path: dir, scope: 'global' }])

    writeFileSync(join(dir, 'test.txt'), 'not markdown')
    writeFileSync(join(dir, 'test.json'), '{}')
    await waitFlush()

    expect(changes.length).toBe(0)
  })

  it('should_ignore_MEMORY_md', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memwatch-'))
    const changes: MemoryFileChange[] = []
    watcher = new MemoryWatcher(c => changes.push(...c))
    watcher.start([{ path: dir, scope: 'project' }])

    writeFileSync(join(dir, 'MEMORY.md'), '# Index')
    await waitFlush()

    expect(changes.length).toBe(0)
  })

  it('should_skip_self_write_paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memwatch-'))
    const changes: MemoryFileChange[] = []
    watcher = new MemoryWatcher(c => changes.push(...c))
    watcher.start([{ path: dir, scope: 'project' }])

    const filePath = join(dir, 'self.md').replace(/\\/g, '/')
    watcher.markSelfWrite(filePath)
    writeFileSync(join(dir, 'self.md'), '# Self write')
    await waitFlush()

    // 被标记为 selfWrite 的文件不触发回调
    expect(changes.filter(c => c.filePath.includes('self.md')).length).toBe(0)

    // 解除标记后再写入应该触发
    watcher.unmarkSelfWrite(filePath)
    writeFileSync(join(dir, 'self.md'), '# Updated')
    await waitFlush()

    expect(changes.some(c => c.filePath.includes('self.md'))).toBe(true)
  })

  it('should_detect_file_deletion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memwatch-'))
    writeFileSync(join(dir, 'to-delete.md'), '# Will be deleted')

    const changes: MemoryFileChange[] = []
    watcher = new MemoryWatcher(c => changes.push(...c))
    watcher.start([{ path: dir, scope: 'project' }])

    unlinkSync(join(dir, 'to-delete.md'))
    await waitFlush()

    expect(changes.some(c => c.filePath.includes('to-delete.md') && c.type === 'delete')).toBe(true)
  })

  it('should_watch_subdirectory_files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memwatch-'))
    mkdirSync(join(dir, 'insights'), { recursive: true })

    const changes: MemoryFileChange[] = []
    watcher = new MemoryWatcher(c => changes.push(...c))
    watcher.start([{ path: dir, scope: 'project' }])

    writeFileSync(join(dir, 'insights', 'deep.md'), '# Deep file')
    await waitFlush()

    expect(changes.some(c => c.filePath.includes('deep.md'))).toBe(true)
  })

  it('should_stop_watching_after_stop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memwatch-'))
    const changes: MemoryFileChange[] = []
    watcher = new MemoryWatcher(c => changes.push(...c))
    watcher.start([{ path: dir, scope: 'project' }])

    watcher.stop()

    writeFileSync(join(dir, 'after-stop.md'), '# Should not trigger')
    await waitFlush()

    expect(changes.length).toBe(0)
  })
})
