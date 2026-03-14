// src/observability/token-meter.ts

/**
 * TokenMeter — 独立观察者，订阅 AgentEvent 中的 llm_usage 事件。
 *
 * 职责：
 * - 写入 SQLite usage_logs（四维 token + 费用）
 * - 内聚计价匹配逻辑（查 pricing_rules 表）
 * - 维护会话级累计统计（供 StatusBar 实时读取）
 * - 提供 getTodayStats / getMonthStats 查询接口
 */

import type { Database as DatabaseType, Statement } from 'libsql'
import { getDb } from '@persistence/db.js'
import type { AgentEvent } from '@core/agent-loop.js'

export interface SessionCostStats {
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  /** 按币种分组的累计费用 { USD: 1.23, CNY: 4.56 } */
  costByCurrency: Record<string, number>
  callCount: number
}

export interface AggregateStats {
  totalInputTokens: number
  totalOutputTokens: number
  totalCost: number
  currency: string
  callCount: number
}

interface PricingRule {
  id: number
  input_price: number
  output_price: number
  cache_read_price: number
  cache_write_price: number
  currency: string
}

export class TokenMeter {
  readonly #db: DatabaseType
  #sessionId: string | null = null
  #provider: string = ''
  #model: string = ''
  #stats: SessionCostStats = TokenMeter.#emptyStats()

  // 缓存 prepared statements，避免每次 consume 重复解析 SQL
  readonly #insertStmt: Statement
  readonly #pricingStmt: Statement
  readonly #todayStmt: Statement
  readonly #monthStmt: Statement

  // 缓存匹配到的计价规则（provider+model 不变时复用）
  #cachedRuleKey: string = ''
  #cachedRule: PricingRule | null = null

  constructor(db?: DatabaseType) {
    this.#db = db ?? getDb()
    this.#insertStmt = this.#db.prepare(`
      INSERT INTO usage_logs (session_id, timestamp, provider, model, input_tokens, output_tokens, cache_read, cache_write, cost_amount, cost_currency, pricing_rule_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.#pricingStmt = this.#db.prepare(`
      SELECT id, model_pattern, input_price, output_price, cache_read_price, cache_write_price, currency
      FROM pricing_rules
      WHERE provider = ?
        AND effective_from <= ?
        AND (effective_to IS NULL OR effective_to > ?)
      ORDER BY priority DESC, effective_from DESC
    `)
    this.#todayStmt = this.#db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) as totalInputTokens,
        COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
        COALESCE(SUM(cost_amount), 0) as totalCost,
        cost_currency as currency,
        COUNT(*) as callCount
      FROM usage_logs
      WHERE timestamp >= ?
      GROUP BY cost_currency
    `)
    this.#monthStmt = this.#db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) as totalInputTokens,
        COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
        COALESCE(SUM(cost_amount), 0) as totalCost,
        cost_currency as currency,
        COUNT(*) as callCount
      FROM usage_logs
      WHERE timestamp >= ?
      GROUP BY cost_currency
    `)
  }

  /** 绑定到当前会话（submit 时调用） */
  bind(sessionId: string, provider: string, model: string): void {
    if (this.#sessionId !== sessionId) {
      this.#stats = TokenMeter.#emptyStats()
    }
    // provider/model 变更时清空规则缓存
    const ruleKey = `${provider}:${model}`
    if (this.#cachedRuleKey !== ruleKey) {
      this.#cachedRuleKey = ruleKey
      this.#cachedRule = null
    }
    this.#sessionId = sessionId
    this.#provider = provider
    this.#model = model
  }

  /** 消费 AgentEvent，只处理 llm_usage */
  consume(event: AgentEvent): void {
    if (event.type !== 'llm_usage') return
    if (!this.#sessionId) return

    const rule = this.#resolveRule()
    const cost = rule
      ? this.#calculateCost(event.inputTokens, event.outputTokens, event.cacheReadTokens, event.cacheWriteTokens, rule)
      : null
    const currency = rule?.currency ?? 'USD'

    this.#insertStmt.run(
      this.#sessionId,
      new Date().toISOString(),
      this.#provider,
      this.#model,
      event.inputTokens,
      event.outputTokens,
      event.cacheReadTokens,
      event.cacheWriteTokens,
      cost,
      currency,
      rule?.id ?? null,
    )

    // 累计会话统计
    this.#stats.totalInputTokens += event.inputTokens
    this.#stats.totalOutputTokens += event.outputTokens
    this.#stats.totalCacheReadTokens += event.cacheReadTokens
    this.#stats.totalCacheWriteTokens += event.cacheWriteTokens
    if (cost != null) {
      this.#stats.costByCurrency[currency] = (this.#stats.costByCurrency[currency] ?? 0) + cost
    }
    this.#stats.callCount++
  }

  /** 当前会话统计（内存累计，无 SQL 查询） */
  getSessionStats(): SessionCostStats {
    return { ...this.#stats, costByCurrency: { ...this.#stats.costByCurrency } }
  }

  /** 今日汇总（SQL 聚合，按币种分组，使用本地日期） */
  getTodayStats(): AggregateStats[] {
    const todayStart = startOfLocalDay()
    return this.#todayStmt.all(todayStart) as AggregateStats[]
  }

  /** 本月汇总（SQL 聚合，按币种分组，使用本地日期） */
  getMonthStats(): AggregateStats[] {
    const monthStart = startOfLocalMonth()
    return this.#monthStmt.all(monthStart) as AggregateStats[]
  }

  /** 解析计价规则（带缓存：同一 provider+model 只查一次 DB） */
  #resolveRule(): PricingRule | null {
    const key = `${this.#provider}:${this.#model}`
    if (this.#cachedRuleKey === key && this.#cachedRule !== null) {
      return this.#cachedRule
    }

    const now = new Date().toISOString()
    const rules = this.#pricingStmt.all(this.#provider, now, now) as Array<PricingRule & { model_pattern: string }>

    for (const rule of rules) {
      if (this.#matchPattern(rule.model_pattern, this.#model)) {
        this.#cachedRuleKey = key
        this.#cachedRule = rule
        return rule
      }
    }
    // 未匹配也缓存结果，避免每次都查 DB
    this.#cachedRuleKey = key
    return null
  }

  /** 简单通配符匹配：仅支持末尾 * */
  #matchPattern(pattern: string, value: string): boolean {
    if (pattern === '*') return true
    if (pattern.endsWith('*')) {
      return value.startsWith(pattern.slice(0, -1))
    }
    return pattern === value
  }

  /** 四维费用计算 */
  #calculateCost(input: number, output: number, cacheRead: number, cacheWrite: number, rule: PricingRule): number {
    return (
      input * rule.input_price +
      output * rule.output_price +
      cacheRead * rule.cache_read_price +
      cacheWrite * rule.cache_write_price
    ) / 1_000_000
  }

  static #emptyStats(): SessionCostStats {
    return {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      costByCurrency: {},
      callCount: 0,
    }
  }
}

/** 返回本地时区的 YYYY-MM-DD 字符串 */
/** 本地今天零点对应的 UTC ISO 字符串 */
function startOfLocalDay(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

/** 本地本月 1 日零点对应的 UTC ISO 字符串 */
function startOfLocalMonth(): string {
  const d = new Date()
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}
