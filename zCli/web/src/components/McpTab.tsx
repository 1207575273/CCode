// src/components/McpTab.tsx

import { useState, useEffect, useCallback } from 'react'
import { apiGet, apiPost } from '../hooks/useApi'

interface McpServerConfig {
  command?: string
  args?: string[]
  type?: string
  url?: string
}

interface McpServerInfo {
  name: string
  config: McpServerConfig
  source: string
  writable: boolean
}

export function McpTab() {
  const [servers, setServers] = useState<McpServerInfo[]>([])
  const [showAdd, setShowAdd] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<'stdio' | 'http'>('stdio')
  // stdio 字段
  const [newCommand, setNewCommand] = useState('')
  const [newArgs, setNewArgs] = useState('')
  // http 字段
  const [newUrl, setNewUrl] = useState('')

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

  const handleAdd = useCallback(async () => {
    if (!newName.trim()) return
    try {
      const config: McpServerConfig = newType === 'stdio'
        ? { command: newCommand, args: newArgs.split(' ').filter(Boolean) }
        : { type: 'streamable-http', url: newUrl }

      await apiPost('/api/mcp/servers/add', { name: newName, config })
      setShowAdd(false)
      setNewName('')
      setNewCommand('')
      setNewArgs('')
      setNewUrl('')
      loadServers()
    } catch (e) { setError(String(e)) }
  }, [newName, newType, newCommand, newArgs, newUrl, loadServers])

  /** 推断传输类型 */
  const getTransport = (config: McpServerConfig): string => {
    if (config.command) return 'stdio'
    if (config.type) return config.type
    if (config.url) return 'http'
    return 'unknown'
  }

  return (
    <div className="space-y-4">
      {/* 操作栏 */}
      <button onClick={() => setShowAdd(!showAdd)}
        className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-500">
        {showAdd ? '收起' : '+ 添加 MCP Server'}
      </button>

      {/* 添加表单 */}
      {showAdd && (
        <div className="bg-gray-800 rounded-lg p-4 border border-blue-500/30">
          <h4 className="text-sm font-medium mb-3">添加 MCP Server</h4>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-400 block mb-1">名称</label>
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="如 mysql, deepwiki"
                className="w-full bg-gray-900 text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-blue-500" />
            </div>

            <div>
              <label className="text-xs text-gray-400 block mb-1">类型</label>
              <div className="flex gap-2">
                <button onClick={() => setNewType('stdio')}
                  className={`px-3 py-1 text-xs rounded ${newType === 'stdio' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-400'}`}>
                  Stdio（本地命令）
                </button>
                <button onClick={() => setNewType('http')}
                  className={`px-3 py-1 text-xs rounded ${newType === 'http' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-400'}`}>
                  HTTP（远程服务）
                </button>
              </div>
            </div>

            {newType === 'stdio' ? (
              <>
                <div>
                  <label className="text-xs text-gray-400 block mb-1">命令</label>
                  <input value={newCommand} onChange={e => setNewCommand(e.target.value)} placeholder="如 npx"
                    className="w-full bg-gray-900 text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="text-xs text-gray-400 block mb-1">参数（空格分隔）</label>
                  <input value={newArgs} onChange={e => setNewArgs(e.target.value)} placeholder="如 -y @anthropic/mcp-mysql"
                    className="w-full bg-gray-900 text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-blue-500" />
                </div>
              </>
            ) : (
              <div>
                <label className="text-xs text-gray-400 block mb-1">URL</label>
                <input value={newUrl} onChange={e => setNewUrl(e.target.value)} placeholder="如 https://mcp.deepwiki.com/mcp"
                  className="w-full bg-gray-900 text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-blue-500" />
              </div>
            )}

            <button onClick={handleAdd} className="px-3 py-1.5 bg-green-600 text-white text-sm rounded hover:bg-green-500">
              添加
            </button>
          </div>
        </div>
      )}

      {/* Server 列表 */}
      {servers.length === 0 ? (
        <p className="text-gray-500 text-sm">暂无 MCP Server 配置</p>
      ) : (
        <div className="space-y-2">
          {servers.map(s => (
            <div key={s.name} className="bg-gray-800 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-lg">🔗</span>
                  <span className="font-medium">{s.name}</span>
                  <span className="text-xs bg-gray-700 px-1.5 py-0.5 rounded text-gray-400">{getTransport(s.config)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">{s.source}</span>
                  {s.writable && (
                    <button onClick={() => handleDelete(s.name)} className="text-red-400 hover:text-red-300 text-xs">删除</button>
                  )}
                </div>
              </div>
              <div className="text-xs text-gray-500 font-mono">
                {s.config.command && <div>command: {s.config.command} {s.config.args?.join(' ')}</div>}
                {s.config.url && <div>url: {s.config.url}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-red-400 text-sm">{error}</p>}
    </div>
  )
}
