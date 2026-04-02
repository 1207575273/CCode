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
 * - POST /api/settings/test-provider — 测试供应商连通性
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
import { createPluginsRoutes } from './plugins-api.js'
import { createMcpRoutes } from './mcp-api.js'
import { broadcastToClients } from '../bridge/server.js'
import { getSystemPromptSections } from '@core/bootstrap.js'
import { FileStore } from '@memory/storage/file-store.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AnthropicProvider } from '@providers/anthropic.js'
import { OpenAICompatProvider } from '@providers/openai-compat.js'
import { ProviderWrapper } from '@providers/wrapper.js'

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

      // 构建 WHERE 子句（支持 from + to 范围）
      const buildWhere = (since: string, until?: string) => {
        const clauses: string[] = []
        const params: string[] = []
        if (since) { clauses.push('timestamp >= ?'); params.push(since) }
        if (until) { clauses.push('timestamp <= ?'); params.push(until) }
        return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params }
      }

      const statsByRange = (since: string, until?: string) => {
        const { where, params } = buildWhere(since, until)
        return db.prepare(`
          SELECT provider, model,
            COALESCE(SUM(input_tokens), 0) as totalInput,
            COALESCE(SUM(output_tokens), 0) as totalOutput,
            COALESCE(SUM(cache_read), 0) as totalCacheRead,
            COALESCE(SUM(cache_write), 0) as totalCacheWrite,
            COALESCE(SUM(cost_amount), 0) as totalCost,
            cost_currency as currency,
            COUNT(*) as callCount
          FROM usage_logs ${where}
          GROUP BY provider, model, cost_currency
          ORDER BY totalCost DESC
        `).all(...params)
      }

      const byProvider = (since: string, until?: string) => {
        const { where, params } = buildWhere(since, until)
        return db.prepare(`
          SELECT provider,
            COALESCE(SUM(input_tokens), 0) as totalInput,
            COALESCE(SUM(output_tokens), 0) as totalOutput,
            COALESCE(SUM(cache_read), 0) as totalCacheRead,
            COALESCE(SUM(cache_write), 0) as totalCacheWrite,
            COALESCE(SUM(input_tokens + output_tokens + cache_read + cache_write), 0) as totalTokens,
            COALESCE(SUM(cost_amount), 0) as totalCost,
            cost_currency as currency,
            COUNT(*) as callCount
          FROM usage_logs ${where}
          GROUP BY provider, cost_currency
          ORDER BY totalTokens DESC
        `).all(...params)
      }

      // 趋势数据：按范围动态选择分组粒度
      // 当日 → 按小时，本周 → 按天，本月 → 按天，自定义 → 按天
      const trendByHour = (since: string, until?: string) => {
        const { where, params } = buildWhere(since, until)
        return db.prepare(`
          SELECT strftime('%Y-%m-%d %H:00', timestamp) as date,
            COALESCE(SUM(input_tokens), 0) as totalInput,
            COALESCE(SUM(output_tokens), 0) as totalOutput,
            COALESCE(SUM(cost_amount), 0) as totalCost,
            COUNT(*) as callCount
          FROM usage_logs ${where}
          GROUP BY strftime('%Y-%m-%d %H:00', timestamp)
          ORDER BY date
        `).all(...params)
      }

      const trendByDay = (since: string, until?: string) => {
        const { where, params } = buildWhere(since, until)
        return db.prepare(`
          SELECT DATE(timestamp) as date,
            COALESCE(SUM(input_tokens), 0) as totalInput,
            COALESCE(SUM(output_tokens), 0) as totalOutput,
            COALESCE(SUM(cost_amount), 0) as totalCost,
            COUNT(*) as callCount
          FROM usage_logs ${where}
          GROUP BY DATE(timestamp)
          ORDER BY date
        `).all(...params)
      }

      const sessions = sessionStore.list({ limit: 50 })
      const customFrom = c.req.query('from')
      const customTo = c.req.query('to')

      return c.json({
        today: {
          stats: statsByRange(todayStart.toISOString()),
          byProvider: byProvider(todayStart.toISOString()),
          trend: trendByHour(todayStart.toISOString()),
        },
        week: {
          stats: statsByRange(weekStart.toISOString()),
          byProvider: byProvider(weekStart.toISOString()),
          trend: trendByDay(weekStart.toISOString()),
        },
        month: {
          stats: statsByRange(monthStart.toISOString()),
          byProvider: byProvider(monthStart.toISOString()),
          trend: trendByDay(monthStart.toISOString()),
        },
        custom: customFrom ? {
          stats: statsByRange(customFrom, customTo),
          byProvider: byProvider(customFrom, customTo),
          trend: trendByDay(customFrom, customTo),
        } : null,
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
      const subagents = sessionStore.loadSubagents(sessionId, snapshot.cwd)
      return c.json({ ...snapshot, subagents })
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
      // 广播配置变更给所有 CLI 客户端（刷新内存中的 provider/model）
      // 注意：当前是全局配置，所有 CLI 实例都会收到。后续可做项目级配置隔离。
      const provider = String(merged.defaultProvider ?? '')
      const model = String(merged.defaultModel ?? '')
      broadcastToClients({ type: 'config_changed', provider, model }, 'cli')
      return c.json({ success: true, provider, model })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  // ═══ 测试供应商连通性 ═══

  api.post('/settings/test-provider', async (c) => {
    try {
      const body = await c.req.json() as {
        provider: string
        config: { apiKey: string; baseURL?: string; protocol?: string; models: string[] }
      }
      const { provider: providerName, config: provCfg } = body

      if (!provCfg.apiKey || !provCfg.models?.length) {
        return c.json({ success: false, error: '需要填写 API Key 和至少一个模型' }, 400)
      }

      // 根据协议创建临时 provider
      const protocol = provCfg.protocol === 'anthropic' || (!provCfg.protocol && providerName === 'anthropic')
        ? 'anthropic' : 'openai'
      const cfg = {
        apiKey: provCfg.apiKey,
        models: provCfg.models,
        ...(provCfg.baseURL ? { baseURL: provCfg.baseURL } : {}),
      }
      const raw = protocol === 'anthropic'
        ? new AnthropicProvider(providerName, cfg)
        : new OpenAICompatProvider(providerName, cfg)
      const llm = new ProviderWrapper(raw)

      const model = provCfg.models[0]!
      const startTime = Date.now()

      // 发一条简单消息测试，完整消费流
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15000)

      let gotText = false
      let gotDone = false
      let streamError = ''
      try {
        // 必须完整消费流，不能提前 break——Anthropic SDK 的 stream
        // 需要在 for-await 结束后调用 finalMessage()，提前退出会导致错误
        for await (const chunk of llm.chat({
          model,
          messages: [{ role: 'user', content: 'hi' }],
          maxTokens: 32,
          signal: controller.signal,
        })) {
          if (chunk.type === 'text' && chunk.text) gotText = true
          if (chunk.type === 'error') streamError = chunk.error ?? '未知流错误'
          if (chunk.type === 'done') gotDone = true
        }
      } finally {
        clearTimeout(timeout)
      }

      const durationMs = Date.now() - startTime

      if (streamError) {
        return c.json({ success: false, error: streamError })
      }
      if (gotText || gotDone) {
        return c.json({ success: true, model, durationMs })
      }
      return c.json({ success: false, error: '未收到有效响应' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ success: false, error: msg })
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

  // Plugins + MCP 管理
  api.route('/plugins', createPluginsRoutes())
  api.route('/mcp', createMcpRoutes())

  // ═══ 记忆向量数据 ═══

  api.get('/memory/vectors', async (c) => {
    try {
      const db = getDb()

      // 读取向量维度
      let dimension = 0
      try {
        const dimRow = db.prepare('SELECT value FROM memory_meta WHERE key = ?').get('embedding_dimension') as { value: string } | undefined
        dimension = dimRow ? parseInt(dimRow.value, 10) : 0
        console.log('[Memory API] dimension:', dimension)
      } catch (err) {
        console.log('[Memory API] memory_meta not found:', err instanceof Error ? err.message : err)
      }

      // 读取所有向量 chunk
      let rows: Array<{
        id: string; entry_id: string; scope: string
        chunk_text: string; chunk_index: number
        tags: string; type: string; embedding: Buffer
      }> = []
      if (dimension > 0) {
        try {
          rows = db.prepare(`
            SELECT id, entry_id, scope, chunk_text, chunk_index, tags, type, embedding
            FROM memory_vectors
          `).all() as typeof rows
        } catch (err) {
          console.log('[Memory API] memory_vectors query failed:', err instanceof Error ? err.message : err)
        }
      }

      // F32_BLOB → number[]，截断到 4 位小数减小传输体积
      const chunks = rows.map(row => {
        const buf = row.embedding
        // 安全转换：先 copy 到独立 ArrayBuffer，避免 Node Buffer pool 共享问题
        const copy = new Uint8Array(buf).buffer
        const f32 = new Float32Array(copy)
        const embedding = Array.from(f32, v => +v.toFixed(4))
        return {
          id: row.id,
          entryId: row.entry_id,
          title: row.chunk_text.slice(0, 50).replace(/\n/g, ' '),
          scope: row.scope as 'global' | 'project',
          type: row.type,
          tags: JSON.parse(row.tags || '[]') as string[],
          chunkText: row.chunk_text,
          chunkIndex: row.chunk_index,
          embedding,
        }
      })

      // 扫描文件系统中的记忆条目（无论是否有向量数据都返回）
      const fileStore = new FileStore()
      const globalDir = join(homedir(), '.ccode', 'memory')
      const projectDir = join(process.cwd(), '.ccode', 'memory')
      const globalEntries = await fileStore.scan(globalDir, 'global')
      const projectEntries = await fileStore.scan(projectDir, 'project')
      const entries = [...globalEntries, ...projectEntries].map(e => ({
        id: e.id,
        scope: e.scope,
        title: e.title,
        type: e.type,
        tags: e.tags,
        content: e.content.slice(0, 500),
        source: e.source,
        created: e.created,
        updated: e.updated,
      }))

      // System Prompt sections
      const sections = getSystemPromptSections()
      const systemPrompt = {
        totalTokens: sections.reduce((sum, s) => sum + Math.ceil(s.charLength / 3.5), 0),
        sections: sections.map(s => ({
          name: s.name,
          tokens: Math.ceil(s.charLength / 3.5),
          source: s.name,
        })),
      }

      console.log(`[Memory API] returning: ${chunks.length} chunks, ${entries.length} entries, dim=${dimension}`)
      return c.json({ chunks, entries, systemPrompt, dimension })
    } catch (err) {
      console.error('[API] /memory/vectors error:', err)
      return c.json({ chunks: [], entries: [], systemPrompt: { totalTokens: 0, sections: [] }, dimension: 0 })
    }
  })

  return api
}
