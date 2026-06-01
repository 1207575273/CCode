// src/pages/AgentsPage.tsx

/**
 * AgentsPage — A2A Agent 网格页。
 *
 * 视图结构：
 *   1. 顶部概要：本机会话数 / 远程 Agent 数 / 总节点数
 *   2. Tab 切换：「列表」（两个分区卡片网格）/ 「拓扑」（纯 CSS 同心环）
 *   3. 每 5s 轮询刷新（本机会话心跳变化快）
 *
 * 拓扑视图布局策略（无第三方库）：
 *   - 最外层容器相对定位，固定高度
 *   - 中心节点绝对居中
 *   - 内环（本机会话）按角度均匀排列在半径 R1 圆周
 *   - 外环（远程 Agent）按角度均匀排列在半径 R2 圆周
 *   - 连线用 SVG overlay（绝对全覆盖），根据节点坐标画 line
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { apiGet } from '../hooks/useApi'

// ═══ 类型定义 ═══

/** inbound 被调活动（与 CLI 端 node-status.InboundActivity 对齐） */
export interface InboundTask {
  taskId: string
  messagePreview: string
  caller?: { port?: number; projectName?: string }
  startedAt: string
  state: 'running' | 'completed' | 'failed'
  endedAt?: string
  durationMs?: number
}
export interface InboundActivity {
  active: number
  recent: InboundTask[]
}

/** 本机活跃会话（lockfile 发现） */
export interface LocalAgent {
  sessionId: string
  pid: number
  port: number
  agentCardUrl: string
  projectName: string
  cwd: string
  gitBranch?: string
  hostname: string
  osUser: string
  startedAt: string      // ISO
  lastHeartbeat: string  // ISO
  /** inbound 被调活动（dashboard 跨进程聚合，无活动时缺省） */
  inbound?: InboundActivity
}

/** 远程已信任 Agent */
export interface RemoteAgent {
  id: string
  url: string
  name: string
  alias?: string
  securityScheme: string
  hasToken: boolean
  addedAt: string        // ISO
}

interface AgentsData {
  local: LocalAgent[]
  remote: RemoteAgent[]
}

type ViewTab = 'list' | 'topology'

// ═══ 工具函数 ═══

/** 将 ISO 时间转为相对描述，如"3秒前"、"2分钟前" */
function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  if (diffMs < 0) return '刚刚'
  const secs = Math.floor(diffMs / 1000)
  if (secs < 60) return `${secs}秒前`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}分钟前`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}小时前`
  return `${Math.floor(hrs / 24)}天前`
}

/** 将 sessionId 截取前6位显示 */
function shortId(sessionId: string): string {
  return sessionId.slice(0, 6)
}

/** 从 cwd 中截取末尾目录名作为简短路径显示 */
function shortCwd(cwd: string): string {
  // 兼容 / 和 \ 分隔符
  const parts = cwd.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] ?? cwd
}

/** 发起方来源简写（项目名 > 端口 > "远程"，与 CLI 端一致） */
function formatInboundCaller(caller: InboundTask['caller']): string {
  if (caller?.projectName) return caller.projectName
  if (caller?.port !== undefined) return `:${caller.port}`
  return '远程'
}

/** inbound 单条状态的中文 + 配色 */
function inboundStateMeta(state: InboundTask['state']): { label: string; cls: string } {
  if (state === 'running') return { label: '执行中', cls: 'text-accent' }
  if (state === 'completed') return { label: '完成', cls: 'text-success' }
  return { label: '失败', cls: 'text-error' }
}

// ═══ 子组件：本机会话卡片 ═══

interface LocalCardProps {
  agent: LocalAgent
}

function LocalAgentCard({ agent }: LocalCardProps) {
  const [copied, setCopied] = useState(false)
  const [copiedSid, setCopiedSid] = useState(false)
  const addr = `http://127.0.0.1:${agent.port}`

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(addr)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // 浏览器权限拒绝时静默处理
    }
  }, [addr])

  const handleCopySessionId = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(agent.sessionId)
      setCopiedSid(true)
      setTimeout(() => setCopiedSid(false), 1500)
    } catch {
      // 浏览器权限拒绝时静默处理
    }
  }, [agent.sessionId])

  return (
    <div className="bg-surface border border-border rounded-lg p-4 flex flex-col gap-2 hover:border-accent transition-colors">
      {/* 项目名 + 端口（端口唯一，一眼区分同名会话） */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-base font-semibold text-txt-primary truncate">
          {agent.projectName}
        </span>
        <span className="text-xs font-mono text-accent bg-elevated px-1.5 py-0.5 rounded shrink-0" title="端口（调用时可直接用）">
          :{agent.port}
        </span>
      </div>

      {/* 完整 sessionId（UUIDv7 前缀同源，同期会话需完整 id 才能区分；点击全选复制） */}
      <button
        onClick={handleCopySessionId}
        className="font-mono text-[11px] text-txt-secondary bg-elevated px-2 py-1 rounded break-all text-left hover:text-accent transition-colors"
        title="点击复制会话 id（调用 dispatch_remote_agent 时可用）"
      >
        {agent.sessionId}
        {copiedSid && <span className="text-success ml-1.5">已复制</span>}
      </button>

      {/* 地址（可点击复制） */}
      <button
        onClick={handleCopy}
        className="flex items-center gap-1.5 text-sm text-accent hover:text-accent-hover transition-colors text-left"
        title={`点击复制地址：${addr}`}
      >
        <IconCopy size={13} />
        <span className="font-mono">{addr}</span>
        {copied && <span className="text-success text-xs ml-1">已复制</span>}
      </button>

      {/* cwd + git 分支 */}
      <div className="flex items-center gap-2 text-xs text-txt-secondary">
        <span className="truncate" title={agent.cwd}>{shortCwd(agent.cwd)}</span>
        {agent.gitBranch && (
          <>
            <span className="text-txt-muted">|</span>
            <span className="text-txt-muted font-mono truncate">{agent.gitBranch}</span>
          </>
        )}
      </div>

      {/* 心跳时间 + PID */}
      <div className="flex items-center justify-between text-xs text-txt-muted mt-1 pt-2 border-t border-border-subtle">
        <span>心跳：{relativeTime(agent.lastHeartbeat)}</span>
        <span>PID {agent.pid}</span>
      </div>

      {/* inbound 被调活动（被调方可见反馈） */}
      <InboundActivityBlock inbound={agent.inbound} />
    </div>
  )
}

// ═══ 子组件：inbound 被调活动 ═══

interface InboundActivityBlockProps {
  inbound?: InboundActivity
}

/** 展示该会话最近被其他会话/Agent 调用的记录（最多 5 条） */
function InboundActivityBlock({ inbound }: InboundActivityBlockProps) {
  if (!inbound || inbound.recent.length === 0) return null

  return (
    <div className="mt-1 pt-2 border-t border-border-subtle space-y-1">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-txt-secondary">被调用</span>
        {inbound.active > 0 && (
          <span className="px-1.5 py-0.5 rounded bg-accent/10 text-accent">{inbound.active} 个执行中</span>
        )}
      </div>
      <ul className="space-y-0.5">
        {inbound.recent.slice(0, 5).map((t) => {
          const meta = inboundStateMeta(t.state)
          return (
            <li key={t.taskId} className="flex items-center gap-2 text-[11px] text-txt-muted">
              <span className={`${meta.cls} shrink-0`}>{meta.label}</span>
              <span className="text-txt-secondary shrink-0" title="发起方">{formatInboundCaller(t.caller)}</span>
              <span className="truncate" title={t.messagePreview}>{t.messagePreview}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ═══ 子组件：远程 Agent 卡片 ═══

interface RemoteCardProps {
  agent: RemoteAgent
}

function RemoteAgentCard({ agent }: RemoteCardProps) {
  return (
    <div className="bg-surface border border-border rounded-lg p-4 flex flex-col gap-2 hover:border-accent transition-colors">
      {/* 名称 + alias */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-base font-semibold text-txt-primary truncate">
          {agent.alias ?? agent.name}
        </span>
        {agent.alias && (
          <span className="text-xs text-txt-muted truncate">{agent.name}</span>
        )}
      </div>

      {/* URL */}
      <a
        href={agent.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm text-accent hover:text-accent-hover transition-colors truncate"
        title={agent.url}
      >
        {agent.url}
      </a>

      {/* 鉴权方式 */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-txt-muted">{agent.securityScheme}</span>
        <span
          className={`px-1.5 py-0.5 rounded ${
            agent.hasToken
              ? 'bg-success/10 text-success'
              : 'bg-warning/10 text-warning'
          }`}
        >
          {agent.hasToken ? '已配置 token' : '无鉴权'}
        </span>
      </div>

      {/* 添加时间 */}
      <div className="text-xs text-txt-muted mt-1 pt-2 border-t border-border-subtle">
        添加于 {relativeTime(agent.addedAt)}
      </div>
    </div>
  )
}

// ═══ 子组件：列表视图 ═══

interface ListViewProps {
  local: LocalAgent[]
  remote: RemoteAgent[]
}

function ListView({ local, remote }: ListViewProps) {
  return (
    <div className="space-y-8">
      {/* 本机活跃会话 */}
      <section>
        <h3 className="text-sm font-semibold text-txt-secondary uppercase tracking-wide mb-3">
          本机活跃会话（{local.length}）
        </h3>
        {local.length === 0 ? (
          <EmptyHint
            primary="暂无本机活跃会话"
            secondary="在终端运行 ccode --web 可启动带 A2A 节点的新会话"
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {local.map(a => (
              <LocalAgentCard key={a.sessionId} agent={a} />
            ))}
          </div>
        )}
      </section>

      {/* 远程已信任 Agent */}
      <section>
        <h3 className="text-sm font-semibold text-txt-secondary uppercase tracking-wide mb-3">
          远程已信任 Agent（{remote.length}）
        </h3>
        {remote.length === 0 ? (
          <EmptyHint
            primary="尚未添加远程 Agent"
            secondary="在 ccode 会话中运行 /a2a add <url> 添加远程节点"
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {remote.map(a => (
              <RemoteAgentCard key={a.id} agent={a} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

// ═══ 子组件：空态提示 ═══

interface EmptyHintProps {
  primary: string
  secondary: string
}

function EmptyHint({ primary, secondary }: EmptyHintProps) {
  return (
    <div className="border border-dashed border-border rounded-lg p-6 text-center">
      <p className="text-txt-secondary text-sm">{primary}</p>
      <p className="text-txt-muted text-xs mt-1">{secondary}</p>
    </div>
  )
}

// ═══ 子组件：拓扑视图 ═══

/**
 * 拓扑视图布局说明：
 *
 * 容器：600x600 SVG（响应式 viewBox），相对定位。
 * 坐标系：以容器中心 (cx, cy) 为原点。
 *
 * - 中心节点：本机 CCode 主节点，位于 (cx, cy)
 * - 内环（半径 R1=160）：本机会话节点，均匀分布在圆周
 * - 外环（半径 R2=280）：远程 Agent 节点，均匀分布在圆周
 * - 连线：
 *     中心 -> 每个内环节点（实线，accent 色，低透明度）
 *     内环节点 -> 对应外环节点（虚线，muted 色，低透明度）
 *     当只有单侧节点时，中心直连外环
 *
 * 节点 HTML 通过 <foreignObject> 嵌入，实现正常 Tailwind 样式。
 */

interface TopologyViewProps {
  local: LocalAgent[]
  remote: RemoteAgent[]
}

/** 计算极坐标圆周上的笛卡尔坐标 */
function circlePoint(cx: number, cy: number, r: number, angleRad: number): [number, number] {
  return [cx + r * Math.cos(angleRad), cy + r * Math.sin(angleRad)]
}

/** 在圆周上均匀排列 n 个点，起始角度 startRad（默认从顶部 -π/2 开始） */
function circlePoints(cx: number, cy: number, r: number, n: number, startRad = -Math.PI / 2): Array<[number, number]> {
  if (n === 0) return []
  return Array.from({ length: n }, (_, i) => {
    const angle = startRad + (2 * Math.PI * i) / n
    return circlePoint(cx, cy, r, angle)
  })
}

function TopologyView({ local, remote }: TopologyViewProps) {
  const W = 640
  const H = 580
  const cx = W / 2
  const cy = H / 2
  const R1 = 160  // 内环（本机会话）
  const R2 = 270  // 外环（远程 Agent）

  // 节点矩形半宽/半高（用于连线端点偏移）
  const NODE_W = 80
  const NODE_H = 32

  const localPts = circlePoints(cx, cy, R1, local.length)
  const remotePts = circlePoints(cx, cy, R2, remote.length)

  // 将所有 local+remote 节点都连接到中心（单连中心）
  // 若同时有 local 和 remote，额外将 local[i] 与 remote[i % remote.length] 连线
  const hasAny = local.length > 0 || remote.length > 0

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full max-w-[640px] mx-auto block"
        style={{ minHeight: 320 }}
        aria-label="A2A Agent 拓扑图"
      >
        {/* 同心环参考圆（虚线，辅助感知） */}
        {local.length > 0 && (
          <circle cx={cx} cy={cy} r={R1} fill="none"
            stroke="var(--border)" strokeWidth="1" strokeDasharray="4 6" opacity="0.5" />
        )}
        {remote.length > 0 && (
          <circle cx={cx} cy={cy} r={R2} fill="none"
            stroke="var(--border)" strokeWidth="1" strokeDasharray="4 6" opacity="0.4" />
        )}

        {/* 连线：中心 -> 本机会话节点 */}
        {localPts.map(([x, y], i) => (
          <line key={`lline-${local[i]!.sessionId}`}
            x1={cx} y1={cy} x2={x} y2={y}
            stroke="var(--accent)" strokeWidth="1.5" opacity="0.35"
            strokeLinecap="round" />
        ))}

        {/* 连线：中心 -> 远程 Agent 节点（当无本机会话时直连） */}
        {local.length === 0 && remotePts.map(([x, y], i) => (
          <line key={`rline-${remote[i]!.id}`}
            x1={cx} y1={cy} x2={x} y2={y}
            stroke="var(--accent)" strokeWidth="1.5" opacity="0.25"
            strokeDasharray="5 4" strokeLinecap="round" />
        ))}

        {/* 连线：本机会话 -> 远程 Agent（有本机节点时的延伸线） */}
        {local.length > 0 && remotePts.map(([x, y], i) => {
          // 就近连到内环中距离最近的本机节点
          const srcIdx = i % localPts.length
          const [sx, sy] = localPts[srcIdx]!
          return (
            <line key={`lr-${remote[i]!.id}`}
              x1={sx} y1={sy} x2={x} y2={y}
              stroke="var(--text-muted)" strokeWidth="1" opacity="0.4"
              strokeDasharray="4 4" strokeLinecap="round" />
          )
        })}

        {/* 中心节点 */}
        <g>
          <rect
            x={cx - NODE_W} y={cy - NODE_H / 2}
            width={NODE_W * 2} height={NODE_H}
            rx="8" ry="8"
            fill="var(--accent)" fillOpacity="0.15"
            stroke="var(--accent)" strokeWidth="2"
          />
          <text x={cx} y={cy + 1}
            textAnchor="middle" dominantBaseline="middle"
            fontSize="13" fontWeight="600" fill="var(--accent)">
            本机 CCode
          </text>
        </g>

        {/* 本机会话节点 */}
        {localPts.map(([x, y], i) => {
          const agent = local[i]!
          return (
            <g key={agent.sessionId}>
              <rect
                x={x - NODE_W} y={y - NODE_H / 2}
                width={NODE_W * 2} height={NODE_H}
                rx="6" ry="6"
                fill="var(--bg-surface)"
                stroke="var(--accent)" strokeWidth="1.5"
              />
              {/* 项目名 */}
              <text x={x} y={y - 5}
                textAnchor="middle" dominantBaseline="middle"
                fontSize="11" fontWeight="600" fill="var(--text-primary)">
                {agent.projectName.length > 10 ? agent.projectName.slice(0, 9) + '…' : agent.projectName}
              </text>
              {/* sessionId 前6位 + 端口 */}
              <text x={x} y={y + 10}
                textAnchor="middle" dominantBaseline="middle"
                fontSize="10" fill="var(--text-muted)">
                #{shortId(agent.sessionId)} :{agent.port}
              </text>
            </g>
          )
        })}

        {/* 远程 Agent 节点 */}
        {remotePts.map(([x, y], i) => {
          const agent = remote[i]!
          const displayName = agent.alias ?? agent.name
          return (
            <g key={agent.id}>
              <rect
                x={x - NODE_W} y={y - NODE_H / 2}
                width={NODE_W * 2} height={NODE_H}
                rx="6" ry="6"
                fill="var(--bg-surface)"
                stroke="var(--border)" strokeWidth="1.5"
              />
              {/* 名称 */}
              <text x={x} y={y - 5}
                textAnchor="middle" dominantBaseline="middle"
                fontSize="11" fontWeight="600" fill="var(--text-primary)">
                {displayName.length > 10 ? displayName.slice(0, 9) + '…' : displayName}
              </text>
              {/* 鉴权状态 */}
              <text x={x} y={y + 10}
                textAnchor="middle" dominantBaseline="middle"
                fontSize="10" fill={agent.hasToken ? 'var(--success)' : 'var(--warning)'}>
                {agent.hasToken ? '已鉴权' : '无鉴权'}
              </text>
            </g>
          )
        })}

        {/* 全空时的空态提示 */}
        {!hasAny && (
          <text x={cx} y={cy}
            textAnchor="middle" dominantBaseline="middle"
            fontSize="13" fill="var(--text-muted)">
            暂无节点
          </text>
        )}
      </svg>

      {/* 图例 */}
      <div className="flex items-center justify-center gap-6 mt-2 text-xs text-txt-muted">
        <LegendItem color="var(--accent)" label="本机会话连线" />
        <LegendItem color="var(--text-muted)" dashed label="远程 Agent 连线" />
      </div>
    </div>
  )
}

interface LegendItemProps {
  color: string
  label: string
  dashed?: boolean
}

function LegendItem({ color, label, dashed = false }: LegendItemProps) {
  return (
    <div className="flex items-center gap-1.5">
      <svg width="24" height="8">
        <line
          x1="0" y1="4" x2="24" y2="4"
          stroke={color} strokeWidth="1.5"
          strokeDasharray={dashed ? '4 3' : undefined}
          strokeLinecap="round"
        />
      </svg>
      <span>{label}</span>
    </div>
  )
}

// ═══ 内联小图标（避免循环依赖，轻量 SVG） ═══

interface SmallIconProps {
  size?: number
}

function IconCopy({ size = 14 }: SmallIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
         stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
         strokeLinejoin="round" className="shrink-0">
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
    </svg>
  )
}

// ═══ 主页面组件 ═══

export function AgentsPage() {
  const [data, setData] = useState<AgentsData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<ViewTab>('list')
  // 用 ref 追踪是否已卸载，避免 setState after unmount
  const mountedRef = useRef(true)

  const loadData = useCallback(() => {
    apiGet<AgentsData>('/api/a2a/agents')
      .then(d => { if (mountedRef.current) setData(d) })
      .catch(e => { if (mountedRef.current) setError(String(e)) })
  }, [])

  useEffect(() => {
    mountedRef.current = true
    loadData()
    // 每 5s 轮询，本机会话心跳变化快
    const timer = setInterval(loadData, 5000)
    return () => {
      mountedRef.current = false
      clearInterval(timer)
    }
  }, [loadData])

  // ── 加载态 ──
  if (!data && !error) {
    return (
      <div className="p-6 flex items-center gap-2 text-txt-muted text-sm">
        <span className="animate-pulse">加载中...</span>
      </div>
    )
  }

  // ── 错误态 ──
  if (error) {
    return (
      <div className="p-6">
        <div className="bg-error/10 border border-error/30 rounded-lg p-4">
          <p className="text-error text-sm font-medium">加载失败</p>
          <p className="text-txt-muted text-xs mt-1">{error}</p>
          <button
            onClick={loadData}
            className="mt-3 px-3 py-1.5 text-xs bg-elevated border border-border rounded-md hover:bg-surface transition-colors text-txt-secondary"
          >
            重试
          </button>
        </div>
      </div>
    )
  }

  const local = data!.local
  const remote = data!.remote
  const totalNodes = local.length + remote.length

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      {/* 页头 */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-txt-primary">Agent 网格</h2>
        <span className="text-xs text-txt-muted">每 5 秒自动刷新</span>
      </div>

      {/* 概要统计卡 */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="总节点数" value={totalNodes} />
        <StatCard label="本机活跃会话" value={local.length} accent={local.length > 0} />
        <StatCard label="远程已信任 Agent" value={remote.length} />
      </div>

      {/* Tab 切换 */}
      <div className="flex items-center gap-1 border-b border-border">
        <TabBtn active={tab === 'list'} onClick={() => setTab('list')}>列表</TabBtn>
        <TabBtn active={tab === 'topology'} onClick={() => setTab('topology')}>拓扑</TabBtn>
      </div>

      {/* 内容区 */}
      {tab === 'list' ? (
        <ListView local={local} remote={remote} />
      ) : (
        <TopologyView local={local} remote={remote} />
      )}
    </div>
  )
}

// ═══ 子组件：概要统计卡 ═══

interface StatCardProps {
  label: string
  value: number
  accent?: boolean
}

function StatCard({ label, value, accent = false }: StatCardProps) {
  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <div className={`text-2xl font-bold ${accent ? 'text-accent' : 'text-txt-primary'}`}>
        {value}
      </div>
      <div className="text-xs text-txt-muted mt-1">{label}</div>
    </div>
  )
}

// ═══ 子组件：Tab 按钮 ═══

interface TabBtnProps {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}

function TabBtn({ active, onClick, children }: TabBtnProps) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? 'border-accent text-accent'
          : 'border-transparent text-txt-secondary hover:text-txt-primary'
      }`}
    >
      {children}
    </button>
  )
}
