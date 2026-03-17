// src/components/PluginsTab.tsx

import { useState, useEffect, useCallback } from 'react'
import { apiGet, apiPost } from '../hooks/useApi'

interface PluginInfo {
  name: string
  installPath: string
  version: string
  skillCount: number
  hasHooks: boolean
  description?: string
}

interface ClaudePlugin {
  name: string
  marketplace: string
  version: string
  installPath: string
  alreadyImported: boolean
}

export function PluginsTab() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [claudePlugins, setClaudePlugins] = useState<ClaudePlugin[]>([])
  const [showImport, setShowImport] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 导入进度
  const [importing, setImporting] = useState<string | null>(null) // 当前正在导入的插件名
  const [importDone, setImportDone] = useState<Set<string>>(new Set()) // 已成功导入的

  const loadPlugins = useCallback(() => {
    apiGet<{ plugins: PluginInfo[] }>('/api/plugins')
      .then(d => setPlugins(d.plugins))
      .catch(e => setError(String(e)))
  }, [])

  const loadClaudePlugins = useCallback(() => {
    apiGet<{ available: ClaudePlugin[] }>('/api/plugins/claude-available')
      .then(d => setClaudePlugins(d.available))
      .catch(e => setError(String(e)))
  }, [])

  useEffect(() => { loadPlugins() }, [loadPlugins])

  const handleDelete = useCallback(async (name: string) => {
    if (!window.confirm(`确定删除插件 ${name}？`)) return
    try {
      await apiPost('/api/plugins/delete', { name })
      loadPlugins()
    } catch (e) { setError(String(e)) }
  }, [loadPlugins])

  const handleImport = useCallback(async (plugin: ClaudePlugin) => {
    setImporting(plugin.name)
    try {
      await apiPost('/api/plugins/import-claude', { name: plugin.name, sourcePath: plugin.installPath })
      setImportDone(prev => new Set([...prev, plugin.name]))
      // 短暂显示成功状态后刷新
      setTimeout(() => {
        loadPlugins()
        loadClaudePlugins()
        setImporting(null)
      }, 800)
    } catch (e) {
      setError(String(e))
      setImporting(null)
    }
  }, [loadPlugins, loadClaudePlugins])

  const handleImportAll = useCallback(async () => {
    const toImport = claudePlugins.filter(p => !p.alreadyImported)
    for (const p of toImport) {
      setImporting(p.name)
      try {
        await apiPost('/api/plugins/import-claude', { name: p.name, sourcePath: p.installPath })
        setImportDone(prev => new Set([...prev, p.name]))
        // 每个导入之间加点延迟让动画可见
        await new Promise(r => setTimeout(r, 500))
      } catch { /* 单个失败继续 */ }
    }
    setImporting(null)
    loadPlugins()
    loadClaudePlugins()
  }, [claudePlugins, loadPlugins, loadClaudePlugins])

  return (
    <div className="space-y-4">
      {/* 操作栏 */}
      <div className="flex gap-2">
        <button onClick={() => { setShowImport(!showImport); if (!showImport) loadClaudePlugins() }}
          className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-500">
          {showImport ? '收起导入' : '+ 导入插件'}
        </button>
      </div>

      {/* Claude Code 导入面板 */}
      {showImport && (
        <div className="bg-gray-800 rounded-lg p-4 border border-blue-500/30">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-medium">从 Claude Code CLI 导入</h4>
            {claudePlugins.some(p => !p.alreadyImported) && (
              <button onClick={handleImportAll} className="px-2 py-1 bg-green-600 text-white text-xs rounded hover:bg-green-500">
                全部导入
              </button>
            )}
          </div>
          {claudePlugins.length === 0 ? (
            <p className="text-gray-500 text-sm">未检测到 Claude Code 已安装的插件</p>
          ) : (
            <div className="space-y-2">
              {claudePlugins.map(p => {
                const isImporting = importing === p.name
                const isDone = importDone.has(p.name) || p.alreadyImported
                return (
                  <div key={p.name} className={`flex items-center justify-between p-2 bg-gray-900 rounded transition-colors ${isImporting ? 'ring-1 ring-blue-500/50' : ''} ${isDone ? 'opacity-70' : ''}`}>
                    <div className="flex items-center gap-2">
                      {isImporting && <span className="animate-spin text-blue-400">⟳</span>}
                      {isDone && !isImporting && <span className="text-green-400">✓</span>}
                      <span className="text-sm font-mono">{p.name}</span>
                      <span className="text-xs text-gray-500">v{p.version}</span>
                      <span className="text-xs text-gray-600">{p.marketplace}</span>
                    </div>
                    {isImporting ? (
                      <span className="text-xs text-blue-400 animate-pulse">导入中...</span>
                    ) : isDone ? (
                      <span className="text-xs text-green-400">已导入</span>
                    ) : (
                      <button onClick={() => handleImport(p)} disabled={!!importing}
                        className="px-2 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-500 disabled:opacity-50">
                        导入
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* 已安装列表 */}
      {plugins.length === 0 ? (
        <p className="text-gray-500 text-sm">暂无已安装插件</p>
      ) : (
        <div className="space-y-2">
          {plugins.map(p => (
            <div key={p.name} className="bg-gray-800 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-lg">🔌</span>
                  <span className="font-medium">{p.name}</span>
                  <span className="text-xs text-gray-500">v{p.version}</span>
                </div>
                <button onClick={() => handleDelete(p.name)} className="text-red-400 hover:text-red-300 text-xs">删除</button>
              </div>
              {p.description && <p className="text-sm text-gray-400 mb-2">{p.description}</p>}
              <div className="flex gap-4 text-xs text-gray-500">
                <span>Skills: {p.skillCount} 个</span>
                <span>Hooks: {p.hasHooks ? '有' : '无'}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-red-400 text-sm">{error}</p>}
    </div>
  )
}
