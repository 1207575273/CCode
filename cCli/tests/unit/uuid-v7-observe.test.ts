// tests/unit/uuid-v7-observe.test.ts
// 观测 UUID v7 的生成行为：时间有序、唯一性、同毫秒递增

import { describe, it, expect } from 'vitest'
import { v7 as uuidv7 } from 'uuid'

describe('UUID v7 行为观测', () => {
  it('连续生成 10 个 — 观察前缀和递增性', () => {
    const ids: string[] = []
    for (let i = 0; i < 10; i++) {
      ids.push(uuidv7())
    }

    console.log('\n=== 连续生成 10 个 UUID v7 ===')
    ids.forEach((id, i) => console.log(`  [${i}] ${id}`))

    // 全部唯一
    const unique = new Set(ids)
    expect(unique.size).toBe(10)
    console.log(`\n唯一性: ${unique.size}/10 ✓`)

    // 排序后顺序不变（时间有序 → 字典序递增）
    const sorted = [...ids].sort()
    expect(sorted).toEqual(ids)
    console.log('字典序递增: ✓')
  })

  it('间隔 5ms 生成 5 个 — 观察时间前缀变化', async () => {
    const ids: Array<{ id: string; time: number }> = []
    for (let i = 0; i < 5; i++) {
      ids.push({ id: uuidv7(), time: Date.now() })
      await new Promise(r => setTimeout(r, 5))
    }

    console.log('\n=== 间隔 5ms 生成 5 个 ===')
    ids.forEach(({ id, time }, i) => {
      // UUID v7 前 12 个 hex 字符 = 48 bit 时间戳（去掉连字符）
      const hexTime = id.replace(/-/g, '').slice(0, 12)
      const msFromUuid = parseInt(hexTime, 16)
      console.log(`  [${i}] ${id}  | Date.now()=${time}  | UUID内时间=${msFromUuid}  | 差=${msFromUuid - time}ms`)
    })
  })

  it('同步循环 1000 个 — 确认全部唯一', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      ids.add(uuidv7())
    }
    expect(ids.size).toBe(1000)
    console.log(`\n1000 个同步生成: 全部唯一 (${ids.size}/1000) ✓`)
  })
})
