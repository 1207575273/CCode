// src/pages/OverviewPage.tsx

import { useState, useEffect, useCallback } from 'react'
import { apiGet } from '../hooks/useApi'
import { Link } from 'react-router-dom'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend, BarChart, Bar } from 'recharts'

// ═══ 类型 ═══

interface ProviderStat { provider: string; totalInput: number; totalOutput: number; totalCacheRead: number; totalCacheWrite: number; totalTokens: number; totalCost: number; currency: string; callCount: number }
interface ModelStat { provider: string; model: string; totalInput: number; totalOutput: number; totalCacheRead: number; totalCacheWrite: number; totalCost: number; currency: string; callCount: number }
interface TrendPoint { date: string; totalInput: number; totalOutput: number; totalCost: number; callCount: number }
interface PerfStat { provider: string; model: string; callCount: number; avgTtft: number; minTtft: number; maxTtft: number; avgE2e: number; maxE2e: number; avgTps: number; cacheHitPct: number | null }
interface PerfTrendPoint { date: string; avgTtft: number; maxTtft: number; avgTps: number; avgE2e: number; callCount: number; cacheHitPct: number | null }
interface TtftBucket { bucket: string; count: number }
interface RangeData { stats: ModelStat[]; byProvider: ProviderStat[]; trend: TrendPoint[]; perf: PerfStat[]; perfTrend: PerfTrendPoint[]; ttftDist: TtftBucket[] }
interface SessionSummary { sessionId: string; model: string; provider: string; firstMessage: string; updatedAt: string; fileSize: number }
interface OverviewData { today: RangeData; week: RangeData; month: RangeData; custom: RangeData | null; recentSessions: SessionSummary[] }

type RangeTab = 'today' | 'week' | 'month' | 'custom'
type LayerTab = 'resource' | 'performance'

// ═══ 工具函数 ═══

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16']
const sym = (c: string) => c === 'CNY' ? '¥' : '$'
const fmtTokens = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)
const fmtMs = (n: number | null | undefined) => {
  if (n == null) return '-'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`
}
const TOOLTIP_STYLE = { backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: 8, fontSize: 12 }

// ═══ 主组件 ═══

export function OverviewPage() {
  const [data, setData] = useState<OverviewData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<RangeTab>('today')
  const [layer, setLayer] = useState<LayerTab>('resource')
  const [customFrom, setCustomFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30)
    return d.toISOString().slice(0, 10)
  })
  const [customTo, setCustomTo] = useState(() => new Date().toISOString().slice(0, 10))

  const loadData = useCallback((from?: string, to?: string) => {
    const params = new URLSearchParams()
    if (from) params.set('from', new Date(from).toISOString())
    if (to) params.set('to', new Date(to + 'T23:59:59').toISOString())
    const query = params.toString() ? `?${params.toString()}` : ''
    apiGet<OverviewData>(`/api/overview${query}`)
      .then(setData)
      .catch(e => setError(String(e)))
  }, [])

  useEffect(() => { loadData() }, [loadData])

  const handleCustomSearch = useCallback(() => {
    loadData(customFrom, customTo)
    setTab('custom')
  }, [customFrom, customTo, loadData])

  if (error) return <div className="p-6 text-error">加载失败: {error}</div>
  if (!data) return <div className="p-6 text-txt-secondary">加载中...</div>

  const rangeData = tab === 'custom' ? (data.custom ?? data.today) : data[tab]

  return (
    <div className="p-6 space-y-6">
      <h2 className="text-xl font-bold">总览大盘</h2>

      {/* 一级 Tab：时间范围 */}
      <div className="flex items-center gap-1 border-b border-border">
        <TabBtn active={tab === 'today'} onClick={() => setTab('today')}>当日</TabBtn>
        <TabBtn active={tab === 'week'} onClick={() => setTab('week')}>本周</TabBtn>
        <TabBtn active={tab === 'month'} onClick={() => setTab('month')}>本月</TabBtn>
        <TabBtn active={tab === 'custom'} onClick={() => setTab('custom')}>自定义</TabBtn>
        {tab === 'custom' && (
          <div className="flex items-center gap-2 ml-4">
            <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
              className="bg-elevated text-sm rounded px-2 py-1 outline-none" />
            <span className="text-txt-secondary text-sm">至</span>
            <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
              className="bg-elevated text-sm rounded px-2 py-1 outline-none" />
            <button onClick={handleCustomSearch} className="px-2 py-1 bg-accent text-xs rounded hover:bg-accent-hover">查询</button>
          </div>
        )}
      </div>

      {/* 二级 Tab：资源层 / 性能层 */}
      <div className="flex items-center gap-3">
        <LayerBtn active={layer === 'resource'} onClick={() => setLayer('resource')}>
          📊 资源层 Resource
        </LayerBtn>
        <LayerBtn active={layer === 'performance'} onClick={() => setLayer('performance')}>
          ⚡ 性能层 Performance
        </LayerBtn>
      </div>

      {/* 根据 layer 展示不同内容 */}
      {layer === 'resource' ? (
        <ResourceLayer rangeData={rangeData} tab={tab} />
      ) : (
        <PerformanceLayer rangeData={rangeData} tab={tab} />
      )}

      {/* 会话列表（两个层都展示） */}
      <SessionList data={data} tab={tab} customFrom={customFrom} />
    </div>
  )
}

// ═══════════════════════════════════════════════
// 资源层
// ═══════════════════════════════════════════════

function ResourceLayer({ rangeData, tab }: { rangeData: RangeData; tab: RangeTab }) {
  const totalCalls = rangeData.stats.reduce((s, r) => s + r.callCount, 0)
  const totalInput = rangeData.stats.reduce((s, r) => s + r.totalInput, 0)
  const totalOutput = rangeData.stats.reduce((s, r) => s + r.totalOutput, 0)
  const totalCacheRead = rangeData.stats.reduce((s, r) => s + (r.totalCacheRead ?? 0), 0)
  const totalCacheWrite = rangeData.stats.reduce((s, r) => s + (r.totalCacheWrite ?? 0), 0)
  const costs = rangeData.byProvider.filter(r => r.totalCost > 0).map(r => `${sym(r.currency)}${r.totalCost.toFixed(4)}`)
  const cacheHitPct = (totalCacheRead + totalInput) > 0
    ? Math.round(totalCacheRead * 1000 / (totalCacheRead + totalInput)) / 10
    : 0

  return (
    <div className="space-y-6">
      {/* 汇总卡片 */}
      <div className="grid grid-cols-7 gap-3">
        <BiCard label="调用次数" sub="Call Count" value={String(totalCalls)} />
        <BiCard label="输入 Token" sub="Input" value={fmtTokens(totalInput)} color="text-accent" />
        <BiCard label="输出 Token" sub="Output" value={fmtTokens(totalOutput)} color="text-success" />
        <BiCard label="缓存读取" sub="Cache Read" value={fmtTokens(totalCacheRead)} color="text-cyan-400" />
        <BiCard label="缓存写入" sub="Cache Write" value={fmtTokens(totalCacheWrite)} color="text-purple-400" />
        <BiCard label="缓存命中率" sub="Cache Hit Rate" value={`${cacheHitPct}%`} color="text-cyan-400" />
        <BiCard label="费用" sub="Cost" value={costs.join(' + ') || '-'} color="text-warning" />
      </div>

      {/* Token + 费用趋势折线图 */}
      <div className="bg-elevated rounded-lg p-4">
        <h3 className="text-sm text-txt-secondary mb-3">
          Token 用量趋势 — {tab === 'today' ? '按小时' : '按天'}
        </h3>
        {rangeData.trend.length > 0 ? (
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={rangeData.trend}>
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#9ca3af' }}
                tickFormatter={d => tab === 'today' ? d.slice(11, 16) : d.slice(5)} />
              <YAxis yAxisId="tokens" tick={{ fontSize: 11, fill: '#9ca3af' }} tickFormatter={fmtTokens} />
              <YAxis yAxisId="cost" orientation="right" tick={{ fontSize: 11, fill: '#fbbf24' }} tickFormatter={v => `$${v}`} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#9ca3af' }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line yAxisId="tokens" type="monotone" dataKey="totalInput" stroke="#3b82f6" name="输入 Token" strokeWidth={2} dot={false} />
              <Line yAxisId="tokens" type="monotone" dataKey="totalOutput" stroke="#10b981" name="输出 Token" strokeWidth={2} dot={false} />
              <Line yAxisId="cost" type="monotone" dataKey="totalCost" stroke="#fbbf24" name="费用" strokeWidth={2} dot={false} strokeDasharray="5 5" />
            </LineChart>
          </ResponsiveContainer>
        ) : <Empty />}
      </div>

      {/* 四维饼图：供应商分布 */}
      <div className="bg-elevated rounded-lg p-4">
        <h3 className="text-sm text-txt-secondary mb-3">供应商分布</h3>
        {rangeData.byProvider.length > 0 ? (
          <div className="grid grid-cols-4 gap-4">
            <PieCard title="输入 Token" data={rangeData.byProvider} dataKey="totalInput" />
            <PieCard title="输出 Token" data={rangeData.byProvider} dataKey="totalOutput" />
            <PieCard title="缓存读取" data={rangeData.byProvider} dataKey="totalCacheRead" />
            <PieCard title="缓存写入" data={rangeData.byProvider} dataKey="totalCacheWrite" />
          </div>
        ) : <Empty />}
      </div>

      {/* 模型用量明细表 */}
      {rangeData.stats.length > 0 && (
        <div className="bg-elevated rounded-lg p-4">
          <h3 className="text-sm text-txt-secondary mb-3">模型用量明细</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-txt-secondary border-b border-border">
                <th className="px-2 py-2">供应商</th>
                <th className="px-2 py-2">模型</th>
                <th className="px-2 py-2 text-right">调用</th>
                <th className="px-2 py-2 text-right">输入</th>
                <th className="px-2 py-2 text-right">输出</th>
                <th className="px-2 py-2 text-right">缓存读</th>
                <th className="px-2 py-2 text-right">缓存写</th>
                <th className="px-2 py-2 text-right">费用</th>
              </tr>
            </thead>
            <tbody>
              {rangeData.stats.map((r, i) => (
                <tr key={i} className="border-b border-border-subtle">
                  <td className="px-2 py-2 font-mono">{r.provider}</td>
                  <td className="px-2 py-2 font-mono text-txt-primary">{r.model}</td>
                  <td className="px-2 py-2 text-right">{r.callCount}</td>
                  <td className="px-2 py-2 text-right text-accent">{fmtTokens(r.totalInput)}</td>
                  <td className="px-2 py-2 text-right text-success">{fmtTokens(r.totalOutput)}</td>
                  <td className="px-2 py-2 text-right text-cyan-400">{fmtTokens(r.totalCacheRead ?? 0)}</td>
                  <td className="px-2 py-2 text-right text-purple-400">{fmtTokens(r.totalCacheWrite ?? 0)}</td>
                  <td className="px-2 py-2 text-right">{r.totalCost > 0 ? `${sym(r.currency)}${r.totalCost.toFixed(4)}` : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════
// 性能层
// ═══════════════════════════════════════════════

function PerformanceLayer({ rangeData, tab }: { rangeData: RangeData; tab: RangeTab }) {
  const hasPerfData = rangeData.perf && rangeData.perf.length > 0
  const totalPerfCalls = rangeData.perf?.reduce((s, r) => s + r.callCount, 0) ?? 0
  const weightedTtft = totalPerfCalls > 0
    ? Math.round(rangeData.perf.reduce((s, r) => s + r.avgTtft * r.callCount, 0) / totalPerfCalls)
    : 0
  const maxTtft = rangeData.perf?.reduce((m, r) => Math.max(m, r.maxTtft ?? 0), 0) ?? 0
  const weightedE2e = totalPerfCalls > 0
    ? Math.round(rangeData.perf.reduce((s, r) => s + r.avgE2e * r.callCount, 0) / totalPerfCalls)
    : 0
  const weightedTps = totalPerfCalls > 0
    ? Math.round(rangeData.perf.reduce((s, r) => s + r.avgTps * r.callCount, 0) / totalPerfCalls * 10) / 10
    : 0

  if (!hasPerfData) {
    return (
      <div className="bg-elevated rounded-lg p-8 text-center">
        <div className="text-txt-muted text-sm">暂无性能数据</div>
        <div className="text-txt-muted text-xs mt-2">开始一次对话后，将自动采集 TTFT、TPS、E2E 等指标</div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* 性能汇总卡片 */}
      <div className="grid grid-cols-4 gap-3">
        <BiCard label="平均首字延迟" sub="Avg TTFT" value={fmtMs(weightedTtft)} color="text-orange-400" />
        <BiCard label="最大首字延迟" sub="Max TTFT" value={fmtMs(maxTtft)} color="text-red-400" />
        <BiCard label="平均端到端耗时" sub="Avg E2E Latency" value={fmtMs(weightedE2e)} color="text-yellow-400" />
        <BiCard label="平均输出吞吐" sub="Avg TPS" value={`${weightedTps} t/s`} color="text-emerald-400" />
      </div>

      {/* TTFT 趋势折线图 */}
      {rangeData.perfTrend && rangeData.perfTrend.length > 1 && (
        <div className="bg-elevated rounded-lg p-4">
          <h3 className="text-sm text-txt-secondary mb-3">
            首字延迟趋势 <span className="text-txt-muted">TTFT Trend</span> — {tab === 'today' ? '按小时' : '按天'}
          </h3>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={rangeData.perfTrend}>
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#9ca3af' }}
                tickFormatter={d => tab === 'today' ? d.slice(11, 16) : d.slice(5)} />
              <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} tickFormatter={v => fmtMs(Number(v))} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#9ca3af' }} formatter={(v: number) => fmtMs(v)} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="avgTtft" stroke="#f97316" name="平均 TTFT" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="maxTtft" stroke="#ef4444" name="最大 TTFT" strokeWidth={1.5} dot={false} strokeDasharray="5 5" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 左右两栏：TTFT 分布 + TPS 趋势 */}
      <div className="grid grid-cols-2 gap-4">
        {/* TTFT 分布直方图 */}
        <div className="bg-elevated rounded-lg p-4">
          <h3 className="text-sm text-txt-secondary mb-3">
            首字延迟分布 <span className="text-txt-muted">TTFT Distribution</span>
          </h3>
          {rangeData.ttftDist && rangeData.ttftDist.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={rangeData.ttftDist}>
                <XAxis dataKey="bucket" tick={{ fontSize: 10, fill: '#9ca3af' }} />
                <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} />
                <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#9ca3af' }} />
                <Bar dataKey="count" fill="#f97316" radius={[4, 4, 0, 0]} name="请求数" />
              </BarChart>
            </ResponsiveContainer>
          ) : <Empty />}
        </div>

        {/* TPS 趋势折线图 */}
        <div className="bg-elevated rounded-lg p-4">
          <h3 className="text-sm text-txt-secondary mb-3">
            输出吞吐趋势 <span className="text-txt-muted">TPS Trend</span>
          </h3>
          {rangeData.perfTrend && rangeData.perfTrend.length > 1 ? (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={rangeData.perfTrend}>
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#9ca3af' }}
                  tickFormatter={d => tab === 'today' ? d.slice(11, 16) : d.slice(5)} />
                <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} tickFormatter={v => `${v} t/s`} />
                <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#9ca3af' }} formatter={(v: number) => `${v} t/s`} />
                <Line type="monotone" dataKey="avgTps" stroke="#10b981" name="平均 TPS" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : <Empty />}
        </div>
      </div>

      {/* 模型性能对比表 */}
      {rangeData.perf.length > 0 && (
        <div className="bg-elevated rounded-lg p-4">
          <h3 className="text-sm text-txt-secondary mb-3">
            模型性能对比 <span className="text-txt-muted">Model Performance</span>
          </h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-txt-secondary border-b border-border">
                <th className="px-2 py-2">供应商</th>
                <th className="px-2 py-2">模型</th>
                <th className="px-2 py-2 text-right">调用</th>
                <th className="px-2 py-2 text-right"><div>平均首字延迟</div><div className="text-txt-muted font-normal">Avg TTFT</div></th>
                <th className="px-2 py-2 text-right"><div>最大首字延迟</div><div className="text-txt-muted font-normal">Max TTFT</div></th>
                <th className="px-2 py-2 text-right"><div>平均端到端</div><div className="text-txt-muted font-normal">Avg E2E</div></th>
                <th className="px-2 py-2 text-right"><div>平均吞吐</div><div className="text-txt-muted font-normal">Avg TPS</div></th>
                <th className="px-2 py-2 text-right"><div>缓存命中率</div><div className="text-txt-muted font-normal">Cache Hit%</div></th>
              </tr>
            </thead>
            <tbody>
              {rangeData.perf.map((r, i) => (
                <tr key={i} className="border-b border-border-subtle">
                  <td className="px-2 py-2 font-mono">{r.provider}</td>
                  <td className="px-2 py-2 font-mono text-txt-primary">{r.model}</td>
                  <td className="px-2 py-2 text-right">{r.callCount}</td>
                  <td className="px-2 py-2 text-right text-orange-400">{fmtMs(r.avgTtft)}</td>
                  <td className="px-2 py-2 text-right text-red-400">{fmtMs(r.maxTtft)}</td>
                  <td className="px-2 py-2 text-right text-yellow-400">{fmtMs(r.avgE2e)}</td>
                  <td className="px-2 py-2 text-right text-emerald-400">{r.avgTps} t/s</td>
                  <td className="px-2 py-2 text-right text-cyan-400">{r.cacheHitPct != null ? `${r.cacheHitPct}%` : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════
// 会话列表
// ═══════════════════════════════════════════════

function SessionList({ data, tab, customFrom }: { data: OverviewData; tab: RangeTab; customFrom: string }) {
  const now = new Date()
  let since: Date
  if (tab === 'today') { since = new Date(now); since.setHours(0, 0, 0, 0) }
  else if (tab === 'week') { since = new Date(now); since.setDate(since.getDate() - since.getDay()); since.setHours(0, 0, 0, 0) }
  else if (tab === 'month') { since = new Date(now); since.setDate(1); since.setHours(0, 0, 0, 0) }
  else { since = new Date(customFrom) }

  const filtered = data.recentSessions.filter(s => new Date(s.updatedAt) >= since)

  return (
    <div className="bg-elevated rounded-lg p-4">
      <h3 className="text-sm text-txt-secondary mb-3">
        {tab === 'today' ? '当日会话' : tab === 'week' ? '本周会话' : tab === 'month' ? '本月会话' : '时间段内会话'}
      </h3>
      {filtered.length === 0 ? (
        <p className="text-txt-muted text-sm">该时间段无会话</p>
      ) : (
        <div className="space-y-1">
          {filtered.slice(0, 10).map(s => (
            <Link key={s.sessionId} to={`/conversations/${s.sessionId}`}
              className="flex items-center justify-between p-2 rounded hover:bg-elevated transition-colors">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-txt-secondary">{s.sessionId.slice(0, 8)}</span>
                <span className="text-xs bg-elevated px-1.5 py-0.5 rounded">{s.model}</span>
              </div>
              <span className="text-xs text-txt-secondary">{new Date(s.updatedAt).toLocaleString()}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════
// 通用子组件
// ═══════════════════════════════════════════════

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className={`px-4 py-2 text-sm border-b-2 -mb-[1px] transition-colors ${active ? 'border-blue-500 text-accent' : 'border-transparent text-txt-secondary hover:text-txt-primary'}`}>{children}</button>
}

function LayerBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`px-4 py-1.5 text-sm rounded-md transition-colors ${active ? 'bg-accent text-white' : 'bg-elevated text-txt-secondary hover:text-txt-primary'}`}>
      {children}
    </button>
  )
}

/** 双行卡片：中文标签 + 英文副标签 */
function BiCard({ label, sub, value, color }: { label: string; sub: string; value: string; color?: string }) {
  return (
    <div className="bg-elevated rounded-lg p-3">
      <div className="text-xs text-txt-secondary">{label}</div>
      <div className="text-[10px] text-txt-muted">{sub}</div>
      <div className={`text-lg font-bold mt-1 ${color ?? ''}`}>{value}</div>
    </div>
  )
}

function Card({ label, value, color }: { label: string; value: string; color?: string }) {
  return <div className="bg-elevated rounded-lg p-3"><div className="text-xs text-txt-secondary mb-1">{label}</div><div className={`text-lg font-bold ${color ?? ''}`}>{value}</div></div>
}

function PieCard({ title, data, dataKey }: { title: string; data: ProviderStat[]; dataKey: string }) {
  const filtered = data.filter(d => (d as unknown as Record<string, number>)[dataKey] > 0)
  if (filtered.length === 0) return (
    <div className="text-center">
      <div className="text-xs text-txt-secondary mb-2">{title}</div>
      <div className="h-[160px] flex items-center justify-center text-txt-muted text-xs">无数据</div>
    </div>
  )
  return (
    <div className="text-center">
      <div className="text-xs text-txt-secondary mb-2">{title}</div>
      <ResponsiveContainer width="100%" height={160}>
        <PieChart>
          <Pie data={filtered} dataKey={dataKey} nameKey="provider"
            cx="50%" cy="50%" outerRadius={55}
            label={({ name, percent }) => `${name ?? ''} ${((percent ?? 0) * 100).toFixed(0)}%`}
            labelLine={false} fontSize={10}>
            {filtered.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
          </Pie>
          <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: 8, fontSize: 11 }}
            formatter={(v) => fmtTokens(Number(v ?? 0))} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  )
}

function Empty() {
  return <div className="h-[160px] flex items-center justify-center text-txt-muted text-sm">暂无数据</div>
}
