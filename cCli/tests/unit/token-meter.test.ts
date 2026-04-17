import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { TokenMeter } from '@observability/token-meter.js'
import { createDb } from '@persistence/db.js'
import type { AgentEvent } from '@core/agent-loop.js'
import type { Database } from 'libsql'

let db: Database

beforeEach(() => {
  db = createDb(':memory:')
})

afterEach(() => {
  db.close()
})

describe('TokenMeter.consume', () => {
  it('should_write_usage_log_on_llm_done', () => {
    const meter = new TokenMeter(db)
    meter.bind('session-1', 'anthropic', 'claude-opus-4-6')

    const event: AgentEvent = {
      type: 'llm_done', inputTokens: 1000, outputTokens: 200,
      cacheReadTokens: 500, cacheWriteTokens: 0, stopReason: 'end_turn', ttftMs: 0, e2eMs: 0, tps: 0,
    }
    meter.consume(event)

    const rows = db.prepare('SELECT * FROM usage_logs').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.input_tokens).toBe(1000)
    expect(rows[0]!.output_tokens).toBe(200)
    expect(rows[0]!.cache_read).toBe(500)
    expect(rows[0]!.cost_currency).toBe('USD')
  })

  it('should_calculate_cost_with_matching_pricing_rule', () => {
    const meter = new TokenMeter(db)
    meter.bind('session-1', 'anthropic', 'claude-opus-4-6')

    const event: AgentEvent = {
      type: 'llm_done', inputTokens: 1_000_000, outputTokens: 100_000,
      cacheReadTokens: 0, cacheWriteTokens: 0, stopReason: 'end_turn', ttftMs: 0, e2eMs: 0, tps: 0,
    }
    meter.consume(event)

    const row = db.prepare('SELECT cost_amount FROM usage_logs').get() as { cost_amount: number }
    // claude-opus-4-* : input $5/M + output $25/M = 5 + 2.5 = 7.5
    expect(row.cost_amount).toBeCloseTo(7.5, 1)
  })

  it('should_include_cache_tokens_in_cost_calculation', () => {
    const meter = new TokenMeter(db)
    meter.bind('session-1', 'anthropic', 'claude-opus-4-6')

    // claude-opus-4-* 价格: input $5/M, output $25/M, cache_read $0.50/M, cache_write $6.25/M
    const event: AgentEvent = {
      type: 'llm_done', inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000, stopReason: 'end_turn', ttftMs: 0, e2eMs: 0, tps: 0,
    }
    meter.consume(event)

    const row = db.prepare('SELECT cost_amount FROM usage_logs').get() as { cost_amount: number }
    // cache_read: 1M × $0.50/M = $0.50, cache_write: 1M × $6.25/M = $6.25, total = $6.75
    expect(row.cost_amount).toBeCloseTo(6.75, 2)
  })

  it('should_calculate_full_four_dimension_cost', () => {
    const meter = new TokenMeter(db)
    meter.bind('session-1', 'anthropic', 'claude-opus-4-6')

    // 四维同时非零
    const event: AgentEvent = {
      type: 'llm_done', inputTokens: 1_000_000, outputTokens: 100_000,
      cacheReadTokens: 500_000, cacheWriteTokens: 200_000, stopReason: 'end_turn', ttftMs: 0, e2eMs: 0, tps: 0,
    }
    meter.consume(event)

    const row = db.prepare('SELECT cost_amount FROM usage_logs').get() as { cost_amount: number }
    // input: 1M × 5 = 5, output: 0.1M × 25 = 2.5, cache_read: 0.5M × 0.5 = 0.25, cache_write: 0.2M × 6.25 = 1.25
    // total = 5 + 2.5 + 0.25 + 1.25 = 9.0
    expect(row.cost_amount).toBeCloseTo(9.0, 2)
  })

  it('should_set_null_cost_when_no_pricing_rule_matches', () => {
    const meter = new TokenMeter(db)
    meter.bind('session-1', 'unknown-provider', 'unknown-model')

    const event: AgentEvent = {
      type: 'llm_done', inputTokens: 100, outputTokens: 50,
      cacheReadTokens: 0, cacheWriteTokens: 0, stopReason: 'end_turn', ttftMs: 0, e2eMs: 0, tps: 0,
    }
    meter.consume(event)

    const row = db.prepare('SELECT cost_amount FROM usage_logs').get() as { cost_amount: number | null }
    expect(row.cost_amount).toBeNull()
  })

  it('should_ignore_non_llm_done_events', () => {
    const meter = new TokenMeter(db)
    meter.bind('session-1', 'anthropic', 'claude-opus-4-6')

    meter.consume({ type: 'text', text: 'hello' })
    meter.consume({ type: 'done' })
    meter.consume({ type: 'error', error: 'oops' })

    const rows = db.prepare('SELECT * FROM usage_logs').all()
    expect(rows).toHaveLength(0)
  })
})

describe('TokenMeter.getSessionStats', () => {
  it('should_accumulate_tokens_and_cost', () => {
    const meter = new TokenMeter(db)
    meter.bind('session-1', 'anthropic', 'claude-opus-4-6')

    meter.consume({ type: 'llm_done', inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, stopReason: 'end_turn', ttftMs: 0, e2eMs: 0, tps: 0 })
    meter.consume({ type: 'llm_done', inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, stopReason: 'end_turn', ttftMs: 0, e2eMs: 0, tps: 0 })

    const stats = meter.getSessionStats()
    expect(stats.totalInputTokens).toBe(1500)
    expect(stats.totalOutputTokens).toBe(300)
    expect(stats.callCount).toBe(2)
    expect(stats.costByCurrency['USD']).toBeGreaterThan(0)
  })
})

describe('TokenMeter.getTodayStats', () => {
  it('should_query_today_usage_from_sqlite_grouped_by_currency', () => {
    const meter = new TokenMeter(db)
    meter.bind('session-1', 'anthropic', 'claude-opus-4-6')

    meter.consume({ type: 'llm_done', inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, stopReason: 'end_turn', ttftMs: 0, e2eMs: 0, tps: 0 })

    const rows = meter.getTodayStats()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.totalInputTokens).toBe(1000)
    expect(rows[0]!.totalOutputTokens).toBe(200)
    expect(rows[0]!.currency).toBe('USD')
  })

  it('should_return_multiple_rows_for_different_currencies', () => {
    const meter = new TokenMeter(db)

    // USD 调用
    meter.bind('session-1', 'anthropic', 'claude-opus-4-6')
    meter.consume({ type: 'llm_done', inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, stopReason: 'end_turn', ttftMs: 0, e2eMs: 0, tps: 0 })

    // CNY 调用
    meter.bind('session-1', 'glm', 'glm-5')
    meter.consume({ type: 'llm_done', inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, stopReason: 'end_turn', ttftMs: 0, e2eMs: 0, tps: 0 })

    const rows = meter.getTodayStats()
    expect(rows).toHaveLength(2)
    const usdRow = rows.find(r => r.currency === 'USD')
    const cnyRow = rows.find(r => r.currency === 'CNY')
    expect(usdRow).toBeDefined()
    expect(cnyRow).toBeDefined()
    expect(cnyRow!.totalInputTokens).toBe(500)
  })
})
