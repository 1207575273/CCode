// src/components/PluginsTab.tsx

/**
 * 插件与 Skill 管理 — 三个子 Tab：
 * 1. 已安装：当前 plugins + skills 列表
 * 2. Claude Code 导入：从 Claude Code 迁移已安装插件
 * 3. Skills 市场：从 skills.sh 浏览热门 + 命令行安装
 */

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

type SubTab = 'installed' | 'claude' | 'marketplace'

export function PluginsTab() {
  const [subTab, setSubTab] = useState<SubTab>('installed')

  return (
    <div className="space-y-4">
      {/* 子 Tab 切换 */}
      <div className="flex gap-1 border-b border-border">
        <SubTabButton active={subTab === 'installed'} onClick={() => setSubTab('installed')}>
          已安装
        </SubTabButton>
        <SubTabButton active={subTab === 'claude'} onClick={() => setSubTab('claude')}>
          Claude Code 导入
        </SubTabButton>
        <SubTabButton active={subTab === 'marketplace'} onClick={() => setSubTab('marketplace')}>
          Skills 市场
        </SubTabButton>
      </div>

      {subTab === 'installed' && <InstalledPanel />}
      {subTab === 'claude' && <ClaudeImportPanel />}
      {subTab === 'marketplace' && <MarketplacePanel />}
    </div>
  )
}

function SubTabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-sm border-b-2 transition-colors ${
        active
          ? 'border-blue-500 text-accent'
          : 'border-transparent text-txt-secondary hover:text-txt-primary'
      }`}
    >
      {children}
    </button>
  )
}

// ═══════════════════════════════════════════════
// 已安装面板
// ═══════════════════════════════════════════════

function InstalledPanel() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [error, setError] = useState<string | null>(null)

  const loadPlugins = useCallback(() => {
    apiGet<{ plugins: PluginInfo[] }>('/api/plugins')
      .then(d => setPlugins(d.plugins))
      .catch(e => setError(String(e)))
  }, [])

  useEffect(() => { loadPlugins() }, [loadPlugins])

  const handleDelete = useCallback(async (name: string) => {
    if (!window.confirm(`确定删除 ${name}？`)) return
    try {
      await apiPost('/api/plugins/delete', { name })
      loadPlugins()
    } catch (e) { setError(String(e)) }
  }, [loadPlugins])

  return (
    <div className="space-y-2">
      {plugins.length === 0 ? (
        <p className="text-txt-secondary text-sm">暂无已安装插件。可从 "Claude Code 导入" 或 "Skills 市场" 添加。</p>
      ) : (
        plugins.map(p => (
          <div key={p.name} className="bg-elevated rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="font-medium">{p.name}</span>
                <span className="text-xs text-txt-secondary">v{p.version}</span>
              </div>
              <button onClick={() => handleDelete(p.name)} className="text-error hover:text-red-300 text-xs">删除</button>
            </div>
            {p.description && <p className="text-sm text-txt-secondary mb-2">{p.description}</p>}
            <div className="flex gap-4 text-xs text-txt-secondary">
              <span>Skills: {p.skillCount} 个</span>
              <span>Hooks: {p.hasHooks ? '有' : '无'}</span>
            </div>
          </div>
        ))
      )}
      {error && <p className="text-error text-sm">{error}</p>}
    </div>
  )
}

// ═══════════════════════════════════════════════
// Claude Code 导入面板
// ═══════════════════════════════════════════════

function ClaudeImportPanel() {
  const [claudePlugins, setClaudePlugins] = useState<ClaudePlugin[]>([])
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState<string | null>(null)
  const [importDone, setImportDone] = useState<Set<string>>(new Set())

  const loadClaudePlugins = useCallback(() => {
    apiGet<{ available: ClaudePlugin[] }>('/api/plugins/claude-available')
      .then(d => setClaudePlugins(d.available))
      .catch(e => setError(String(e)))
  }, [])

  useEffect(() => { loadClaudePlugins() }, [loadClaudePlugins])

  const handleImport = useCallback(async (plugin: ClaudePlugin) => {
    setImporting(plugin.name)
    try {
      await apiPost('/api/plugins/import-claude', { name: plugin.name, sourcePath: plugin.installPath })
      setImportDone(prev => new Set([...prev, plugin.name]))
      setTimeout(() => {
        loadClaudePlugins()
        setImporting(null)
      }, 800)
    } catch (e) {
      setError(String(e))
      setImporting(null)
    }
  }, [loadClaudePlugins])

  const handleImportAll = useCallback(async () => {
    const toImport = claudePlugins.filter(p => !p.alreadyImported)
    for (const p of toImport) {
      setImporting(p.name)
      try {
        await apiPost('/api/plugins/import-claude', { name: p.name, sourcePath: p.installPath })
        setImportDone(prev => new Set([...prev, p.name]))
        await new Promise(r => setTimeout(r, 500))
      } catch (err) { console.warn(`[Plugins] 导入插件 ${p.name} 失败:`, err) }
    }
    setImporting(null)
    loadClaudePlugins()
  }, [claudePlugins, loadClaudePlugins])

  return (
    <div className="space-y-3">
      <p className="text-sm text-txt-secondary">检测本机 Claude Code 已安装的插件，一键导入到 cCli。</p>

      {claudePlugins.some(p => !p.alreadyImported) && (
        <button onClick={handleImportAll} disabled={!!importing}
          className="px-3 py-1.5 bg-success text-white text-sm rounded hover:bg-success disabled:opacity-50">
          全部导入
        </button>
      )}

      {claudePlugins.length === 0 ? (
        <p className="text-txt-secondary text-sm">未检测到 Claude Code 已安装的插件</p>
      ) : (
        <div className="space-y-2">
          {claudePlugins.map(p => {
            const isImporting = importing === p.name
            const isDone = importDone.has(p.name) || p.alreadyImported
            return (
              <div key={p.name} className={`flex items-center justify-between p-3 bg-elevated rounded-lg transition-colors ${isImporting ? 'ring-1 ring-blue-500/50' : ''} ${isDone ? 'opacity-70' : ''}`}>
                <div className="flex items-center gap-2">
                  {isImporting && <span className="animate-spin text-accent">⟳</span>}
                  {isDone && !isImporting && <span className="text-success">✓</span>}
                  <span className="text-sm font-mono">{p.name}</span>
                  <span className="text-xs text-txt-secondary">v{p.version}</span>
                  <span className="text-xs text-txt-muted">{p.marketplace}</span>
                </div>
                {isImporting ? (
                  <span className="text-xs text-accent animate-pulse">导入中...</span>
                ) : isDone ? (
                  <span className="text-xs text-success">已导入</span>
                ) : (
                  <button onClick={() => handleImport(p)} disabled={!!importing}
                    className="px-2 py-1 bg-accent text-white text-xs rounded hover:bg-accent-hover disabled:opacity-50">
                    导入
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
      {error && <p className="text-error text-sm">{error}</p>}
    </div>
  )
}

// ═══════════════════════════════════════════════
// Skills 市场面板
// ═══════════════════════════════════════════════

/** 热门 Skills 推荐（静态数据，source/skill 已验证） */
const FEATURED_SKILLS = [
  { source: 'vercel-labs/agent-skills', skill: 'vercel-react-best-practices', name: 'react-best-practices', desc: 'React + Next.js 性能优化 40+ 规则', installs: '221K' },
  { source: 'vercel-labs/agent-skills', skill: 'vercel-composition-patterns', name: 'composition-patterns', desc: 'Vercel 组合模式最佳实践', installs: '95K' },
  { source: 'vercel-labs/agent-skills', skill: 'deploy-to-vercel', name: 'deploy-to-vercel', desc: '一键部署到 Vercel', installs: '85K' },
  { source: 'vercel-labs/agent-skills', skill: 'vercel-react-native-skills', name: 'react-native', desc: 'React Native 最佳实践 16 条规则', installs: '60K' },
  { source: 'anthropics/skills', skill: 'claude-api', name: 'claude-api', desc: 'Claude API / Anthropic SDK 使用指南', installs: '87K' },
  { source: 'anthropics/skills', skill: 'claude-code-guide', name: 'claude-code-guide', desc: 'Claude Code CLI 功能指南', installs: '75K' },
]

function MarketplacePanel() {
  const [command, setCommand] = useState('')
  const [installing, setInstalling] = useState(false)
  const [installResult, setInstallResult] = useState<{ success: boolean; message: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  /** 解析用户输入的命令或 URL */
  function parseInput(input: string): { source: string; skill?: string } | null {
    const trimmed = input.trim()
    if (!trimmed) return null

    // 格式1: npx skills add <source> --skill <name>
    const npxMatch = trimmed.match(/npx\s+skills\s+add\s+(\S+)(?:\s+--skill\s+(\S+))?/)
    if (npxMatch) {
      return { source: npxMatch[1]!, skill: npxMatch[2] }
    }

    // 格式2: owner/repo --skill name
    const shortMatch = trimmed.match(/^(\S+\/\S+)(?:\s+--skill\s+(\S+))?$/)
    if (shortMatch) {
      return { source: shortMatch[1]!, skill: shortMatch[2] }
    }

    // 格式3: https://github.com/... URL
    if (trimmed.startsWith('http')) {
      return { source: trimmed }
    }

    return null
  }

  const handleInstall = useCallback(async (source: string, skill?: string) => {
    setInstalling(true)
    setInstallResult(null)
    setError(null)
    try {
      const res = await apiPost<{ success: boolean; message?: string; installed?: string[]; error?: string }>(
        '/api/plugins/install-skill',
        { source, skill },
      )
      if (res.success) {
        setInstallResult({ success: true, message: res.message ?? `安装成功！` })
        setCommand('')
      } else {
        setInstallResult({ success: false, message: res.error ?? '安装失败' })
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setInstalling(false)
    }
  }, [])

  const handleSubmit = useCallback(() => {
    const parsed = parseInput(command)
    if (!parsed) {
      setError('无法解析命令。支持格式：owner/repo、npx skills add <source> --skill <name>、GitHub URL')
      return
    }
    handleInstall(parsed.source, parsed.skill)
  }, [command, handleInstall])

  return (
    <div className="space-y-4">
      {/* 说明 */}
      <div className="text-sm text-txt-secondary">
        <p>
          从{' '}
          <a href="https://skills.sh/" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
            skills.sh
          </a>
          {' '}生态安装 skill，扩展 cCli 的能力。
        </p>
      </div>

      {/* 命令输入框 */}
      <div className="bg-elevated rounded-lg p-4 border border-border">
        <label className="text-sm text-txt-primary mb-2 block">安装 Skill</label>
        <div className="flex gap-2">
          <input
            value={command}
            onChange={e => { setCommand(e.target.value); setError(null); setInstallResult(null) }}
            onKeyDown={e => { if (e.key === 'Enter' && !installing) handleSubmit() }}
            placeholder="vercel-labs/agent-skills --skill find-skills"
            className="flex-1 bg-surface text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:border-accent placeholder-txt-muted font-mono"
            disabled={installing}
          />
          <button
            onClick={handleSubmit}
            disabled={installing || !command.trim()}
            className="px-4 py-2 bg-accent text-white text-sm rounded hover:bg-accent-hover disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            {installing ? '安装中...' : '安装'}
          </button>
        </div>
        <p className="text-xs text-txt-muted mt-1.5">
          支持格式：<code className="text-txt-secondary">owner/repo</code>、
          <code className="text-txt-secondary">npx skills add ...</code>、
          <code className="text-txt-secondary">GitHub URL</code>
        </p>

        {/* 安装结果 */}
        {installResult && (
          <div className={`mt-2 text-sm ${installResult.success ? 'text-success' : 'text-error'}`}>
            {installResult.success ? '✓' : '✗'} {installResult.message}
          </div>
        )}
        {error && <p className="mt-2 text-sm text-error">{error}</p>}
      </div>

      {/* 热门推荐 */}
      <div>
        <h4 className="text-sm font-medium text-txt-primary mb-2">热门 Skills</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {FEATURED_SKILLS.map(s => (
            <div key={s.name} className="bg-elevated rounded-lg p-3 flex items-start justify-between group hover:bg-elevated transition-colors">
              <div className="min-w-0 flex-1 mr-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-txt-primary">{s.name}</span>
                  <span className="text-xs text-txt-muted">{s.installs}</span>
                </div>
                <p className="text-xs text-txt-secondary mt-0.5">{s.desc}</p>
              </div>
              <button
                onClick={() => handleInstall(s.source, s.skill)}
                disabled={installing}
                className="px-2 py-1 bg-elevated text-txt-primary text-xs rounded hover:bg-accent hover:text-white transition-colors disabled:opacity-50 shrink-0"
              >
                安装
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* 更多提示 */}
      <p className="text-xs text-txt-muted">
        浏览更多：
        <a href="https://skills.sh/" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline ml-1">
          skills.sh
        </a>
        {' '}| 275+ skills 可用
      </p>
    </div>
  )
}
