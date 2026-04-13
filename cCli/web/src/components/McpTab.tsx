// src/components/McpTab.tsx

import { useState, useEffect, useCallback } from 'react'
import { apiGet, apiPost } from '../hooks/useApi'

type McpType = 'stdio' | 'sse' | 'streamable-http' | 'http'

interface McpServerConfig {
  command?: string
  args?: string[]
  type?: string
  url?: string
  headers?: Record<string, string>
  env?: Record<string, string>
}

interface McpServerInfo {
  name: string
  config: McpServerConfig
  source: string
  writable: boolean
}

const TYPE_OPTIONS: { value: McpType; label: string; desc: string }[] = [
  { value: 'stdio', label: 'Stdio', desc: '本地命令（如 npx @mcp/server）' },
  { value: 'sse', label: 'SSE', desc: '远程 Server-Sent Events' },
  { value: 'streamable-http', label: 'Streamable HTTP', desc: '远程 HTTP 流式传输' },
  { value: 'http', label: 'HTTP', desc: '远程 HTTP（含自定义请求头）' },
]

export function McpTab() {
  const [servers, setServers] = useState<McpServerInfo[]>([])
  const [showAdd, setShowAdd] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 表单状态
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<McpType>('stdio')
  const [newCommand, setNewCommand] = useState('')
  const [newArgs, setNewArgs] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [newHeaders, setNewHeaders] = useState('')

  const loadServers = useCallback(() => {
    apiGet<{ servers: McpServerInfo[] }>('/api/mcp/servers')
      .then(d => setServers(d.servers))
      .catch(e => setError(String(e)))
  }, [])

  useEffect(() => { loadServers() }, [loadServers])

  const handleDelete = useCallback(async (name: string) => {
    if (!window.confirm(`确定删除 MCP Server "${name}"？`)) return
    try {
      await apiPost('/api/mcp/servers/delete', { name })
      loadServers()
    } catch (e) { setError(String(e)) }
  }, [loadServers])

  const resetForm = () => {
    setNewName(''); setNewCommand(''); setNewArgs(''); setNewUrl(''); setNewHeaders('')
  }

  const handleAdd = useCallback(async () => {
    if (!newName.trim()) return
    try {
      let config: McpServerConfig
      if (newType === 'stdio') {
        config = { command: newCommand, args: newArgs.split(' ').filter(Boolean) }
      } else {
        config = { type: newType, url: newUrl }
        if (newHeaders.trim()) {
          try { config.headers = JSON.parse(newHeaders) } catch { /* headers 输入非合法 JSON，跳过解析（用户输入中间态） */ }
        }
      }

      await apiPost('/api/mcp/servers/add', { name: newName, config })
      setShowAdd(false)
      resetForm()
      loadServers()
    } catch (e) { setError(String(e)) }
  }, [newName, newType, newCommand, newArgs, newUrl, newHeaders, loadServers])

  const getTransport = (config: McpServerConfig): string => {
    if (config.command) return 'stdio'
    return config.type ?? 'http'
  }

  const isRemoteType = newType !== 'stdio'

  return (
    <div className="space-y-4">
      <button onClick={() => setShowAdd(!showAdd)}
        className="px-3 py-1.5 bg-accent text-white text-sm rounded hover:bg-accent-hover">
        {showAdd ? '收起' : '+ 添加 MCP Server'}
      </button>

      {/* 添加表单 */}
      {showAdd && (
        <div className="bg-elevated rounded-lg p-4 border border-blue-500/30">
          <h4 className="text-sm font-medium mb-3">添加 MCP Server</h4>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-txt-secondary block mb-1">名称</label>
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="如 mysql, deepwiki"
                className="w-full bg-surface text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:border-accent" />
            </div>

            {/* 4 种类型选择 */}
            <div>
              <label className="text-xs text-txt-secondary block mb-1">传输类型</label>
              <div className="grid grid-cols-4 gap-2">
                {TYPE_OPTIONS.map(opt => (
                  <button key={opt.value} onClick={() => setNewType(opt.value)}
                    className={`px-2 py-2 text-xs rounded text-center transition-colors ${
                      newType === opt.value ? 'bg-accent text-white' : 'bg-elevated text-txt-secondary hover:bg-elevated'
                    }`}>
                    <div className="font-medium">{opt.label}</div>
                    <div className="text-[10px] mt-0.5 opacity-70">{opt.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Stdio 字段 */}
            {newType === 'stdio' && (
              <>
                <div>
                  <label className="text-xs text-txt-secondary block mb-1">命令</label>
                  <input value={newCommand} onChange={e => setNewCommand(e.target.value)} placeholder="如 npx"
                    className="w-full bg-surface text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:border-accent" />
                </div>
                <div>
                  <label className="text-xs text-txt-secondary block mb-1">参数（空格分隔）</label>
                  <input value={newArgs} onChange={e => setNewArgs(e.target.value)} placeholder="如 -y @anthropic/mcp-mysql"
                    className="w-full bg-surface text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:border-accent" />
                </div>
              </>
            )}

            {/* 远程类型字段（SSE / Streamable HTTP / HTTP） */}
            {isRemoteType && (
              <>
                <div>
                  <label className="text-xs text-txt-secondary block mb-1">URL</label>
                  <input value={newUrl} onChange={e => setNewUrl(e.target.value)} placeholder="如 https://mcp.deepwiki.com/mcp"
                    className="w-full bg-surface text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:border-accent" />
                </div>
                {newType === 'http' && (
                  <div>
                    <label className="text-xs text-txt-secondary block mb-1">请求头（JSON 格式，可选）</label>
                    <input value={newHeaders} onChange={e => setNewHeaders(e.target.value)}
                      placeholder='{"Authorization": "Bearer your-token"}'
                      className="w-full bg-surface text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:border-accent" />
                  </div>
                )}
              </>
            )}

            <button onClick={handleAdd} disabled={!newName.trim()}
              className="px-3 py-1.5 bg-success text-white text-sm rounded hover:bg-success disabled:opacity-50">
              添加
            </button>
          </div>
        </div>
      )}

      {/* Server 列表 */}
      {servers.length === 0 ? (
        <p className="text-txt-secondary text-sm">暂无 MCP Server 配置</p>
      ) : (
        <div className="space-y-2">
          {servers.map(s => (
            <div key={s.name} className="bg-elevated rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-lg">🔗</span>
                  <span className="font-medium">{s.name}</span>
                  <span className="text-xs bg-elevated px-1.5 py-0.5 rounded text-txt-secondary">{getTransport(s.config)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-txt-secondary">{s.source}</span>
                  {s.writable && (
                    <button onClick={() => handleDelete(s.name)} className="text-error hover:text-red-300 text-xs">删除</button>
                  )}
                </div>
              </div>
              <div className="text-xs text-txt-secondary font-mono">
                {s.config.command && <div>command: {s.config.command} {s.config.args?.join(' ')}</div>}
                {s.config.url && <div>url: {s.config.url}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-error text-sm">{error}</p>}
    </div>
  )
}
