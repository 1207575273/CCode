// src/dashboard/api.ts

/**
 * Dashboard REST API — 管理界面数据接口。
 *
 * 只使用 GET（查询）和 POST（写操作），不用 PUT/DELETE。
 *
 * 挂载到 Bridge Server 的 /api 路径下：
 * - GET  /api/overview — 总览大盘数据
 * - GET  /api/conversations — 对话列表
 * - GET  /api/conversations/:id — 对话详情
 * - GET  /api/settings — 读取配置
 * - POST /api/settings/save — 保存配置
 * - GET  /api/pricing — 计价规则列表
 * - POST /api/pricing/add — 新增规则
 * - POST /api/pricing/update — 更新规则
 * - POST /api/pricing/delete — 删除规则
 */

import { Hono } from 'hono'
import { sessionStore } from '@persistence/index.js'
import { getDb } from '@persistence/db.js'
import { configManager } from '@config/config-manager.js'
import { TokenMeter } from '@observability/token-meter.js'

export function createApiRoutes(): Hono {
  const api = new Hono()

  // ═══ 总览大盘 ═══

  api.get('/overview', (c) => {
    try {
      const db = getDb()

      // 按时间范围和 provider 分组的 token 统计
      const now = new Date()
      const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0)
      const weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - weekStart.getDay()); weekStart.setHours(0, 0, 0, 0)
      const monthStart = new Date(now); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0)

      const statsByRange = (since: string) => db.prepare(`
        SELECT provider, model,
          COALESCE(SUM(input_tokens), 0) as totalInput,
          COALESCE(SUM(output_tokens), 0) as totalOutput,
          COALESCE(SUM(cost_amount), 0) as totalCost,
          cost_currency as currency,
          COUNT(*) as callCount
        FROM usage_logs WHERE timestamp >= ?
        GROUP BY provider, model, cost_currency
        ORDER BY totalCost DESC
      `).all(since)

      // 按 provider 分组的饼图数据
      const byProvider = (since: string) => db.prepare(`
        SELECT provider,
          COALESCE(SUM(input_tokens + output_tokens), 0) as totalTokens,
          COALESCE(SUM(cost_amount), 0) as totalCost,
          cost_currency as currency,
          COUNT(*) as callCount
        FROM usage_logs WHERE timestamp >= ?
        GROUP BY provider, cost_currency
        ORDER BY totalTokens DESC
      `).all(since)

      // 最近 7 天每日趋势
      const dailyTrend = db.prepare(`
        SELECT DATE(timestamp) as date,
          COALESCE(SUM(input_tokens), 0) as totalInput,
          COALESCE(SUM(output_tokens), 0) as totalOutput,
          COALESCE(SUM(cost_amount), 0) as totalCost,
          COUNT(*) as callCount
        FROM usage_logs WHERE timestamp >= ?
        GROUP BY DATE(timestamp)
        ORDER BY date
      `).all(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString())

      const sessions = sessionStore.list({ limit: 5 })

      return c.json({
        today: { stats: statsByRange(todayStart.toISOString()), byProvider: byProvider(todayStart.toISOString()) },
        week: { stats: statsByRange(weekStart.toISOString()), byProvider: byProvider(weekStart.toISOString()) },
        month: { stats: statsByRange(monthStart.toISOString()), byProvider: byProvider(monthStart.toISOString()) },
        dailyTrend,
        recentSessions: sessions,
      })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  // ═══ 对话详情 ═══

  api.get('/conversations', (c) => {
    try {
      const limit = Number(c.req.query('limit')) || 20
      const sessions = sessionStore.list({ limit })
      return c.json({ sessions })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  api.get('/conversations/:id', (c) => {
    try {
      const sessionId = c.req.param('id')
      const snapshot = sessionStore.loadMessages(sessionId)
      return c.json(snapshot)
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  // ═══ 设置管理 ═══

  api.get('/settings', (c) => {
    try {
      const config = configManager.load()
      return c.json({ config })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  api.post('/settings/save', async (c) => {
    try {
      const body = await c.req.json() as { config: Record<string, unknown> }
      const current = configManager.load()
      const merged = { ...current, ...body.config }
      configManager.save(merged)
      return c.json({ success: true })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  // ═══ 计价规则 ═══

  api.get('/pricing', (c) => {
    try {
      const db = getDb()
      const rules = db.prepare('SELECT * FROM pricing_rules ORDER BY provider, priority DESC').all()
      return c.json({ rules })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  api.post('/pricing/add', async (c) => {
    try {
      const rule = await c.req.json() as Record<string, unknown>
      const db = getDb()
      const result = db.prepare(`
        INSERT INTO pricing_rules (provider, model_pattern, input_price, output_price, cache_read_price, cache_write_price, currency, effective_from, effective_to, source, priority)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        rule['provider'], rule['model_pattern'],
        rule['input_price'], rule['output_price'],
        rule['cache_read_price'] ?? 0, rule['cache_write_price'] ?? 0,
        rule['currency'] ?? 'USD', rule['effective_from'],
        rule['effective_to'] ?? null, rule['source'] ?? null,
        rule['priority'] ?? 0,
      )
      return c.json({ id: result.lastInsertRowid })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  api.post('/pricing/update', async (c) => {
    try {
      const body = await c.req.json() as { id: number; [key: string]: unknown }
      const { id, ...updates } = body
      const db = getDb()
      const fields = ['provider', 'model_pattern', 'input_price', 'output_price', 'cache_read_price', 'cache_write_price', 'currency', 'effective_from', 'effective_to', 'source', 'priority']
      const setClauses: string[] = []
      const values: unknown[] = []
      for (const field of fields) {
        if (field in updates) {
          setClauses.push(`${field} = ?`)
          values.push(updates[field])
        }
      }
      if (setClauses.length === 0) return c.json({ error: 'No fields to update' }, 400)
      values.push(id)
      db.prepare(`UPDATE pricing_rules SET ${setClauses.join(', ')} WHERE id = ?`).run(...values)
      return c.json({ success: true })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  api.post('/pricing/delete', async (c) => {
    try {
      const body = await c.req.json() as { id: number }
      const db = getDb()
      db.prepare('DELETE FROM pricing_rules WHERE id = ?').run(body.id)
      return c.json({ success: true })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  return api
}
