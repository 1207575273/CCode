// src/pages/SettingsPage.tsx

import { useState, useEffect, useCallback, useMemo } from 'react'
import { apiGet, apiPost } from '../hooks/useApi'
import { PluginsTab } from '../components/PluginsTab'
import { McpTab } from '../components/McpTab'
import { useToast } from '../components/Toast'

interface ProviderConfig {
  apiKey: string
  baseURL?: string
  protocol?: string
  models: string[]
}

interface ZCliConfig {
  defaultProvider: string
  defaultModel: string
  providers: Record<string, ProviderConfig>
}

interface PricingRule {
  id: number
  provider: string
  model_pattern: string
  input_price: number
  output_price: number
  cache_read_price: number
  cache_write_price: number
  currency: string
  effective_from: string
  effective_to: string | null
  source: string | null
  priority: number
}

type Tab = 'providers' | 'pricing' | 'plugins' | 'mcp'

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('providers')

  return (
    <div className="p-6 max-w-4xl">
      <h2 className="text-xl font-bold mb-4">设置管理</h2>

      {/* Tab 切换 */}
      <div className="flex gap-1 mb-6 border-b border-gray-700">
        <TabButton active={tab === 'providers'} onClick={() => setTab('providers')}>Provider 配置</TabButton>
        <TabButton active={tab === 'pricing'} onClick={() => setTab('pricing')}>计价规则</TabButton>
        <TabButton active={tab === 'plugins'} onClick={() => setTab('plugins')}>插件与 Skill</TabButton>
        <TabButton active={tab === 'mcp'} onClick={() => setTab('mcp')}>MCP 管理</TabButton>
      </div>

      {tab === 'providers' && <ProvidersTab />}
      {tab === 'pricing' && <PricingTab />}
      {tab === 'plugins' && <PluginsTab />}
      {tab === 'mcp' && <McpTab />}
    </div>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm transition-colors border-b-2 -mb-[1px] ${
        active ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-400 hover:text-gray-200'
      }`}
    >
      {children}
    </button>
  )
}

// ═══ Provider 配置 Tab ═══

function ProvidersTab() {
  const toast = useToast()
  const [config, setConfig] = useState<ZCliConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    apiGet<{ config: ZCliConfig }>('/api/settings')
      .then(d => setConfig(d.config))
      .catch(e => setError(String(e)))
  }, [])

  // 可选的 provider 名称列表
  const providerNames = useMemo(() => config ? Object.keys(config.providers) : [], [config])

  // 当前选中 provider 的 models 列表
  const currentModels = useMemo(() => {
    if (!config) return []
    const prov = config.providers[config.defaultProvider]
    return prov?.models ?? []
  }, [config])

  const handleProviderChange = useCallback((name: string) => {
    if (!config) return
    const prov = config.providers[name]
    // 切换 provider 时自动选第一个 model
    const firstModel = prov?.models?.[0] ?? config.defaultModel
    setConfig({ ...config, defaultProvider: name, defaultModel: firstModel })
  }, [config])

  const handleSave = useCallback(async () => {
    if (!config) return
    setSaving(true)
    try {
      await apiPost('/api/settings/save', { config })
      setError(null)
      toast.success('配置已保存')
    } catch (e) {
      setError(String(e))
      toast.error('保存失败')
    }
    setSaving(false)
  }, [config, toast])

  if (error && !config) return <div className="text-red-400">加载失败: {error}</div>
  if (!config) return <div className="text-gray-500">加载中...</div>

  return (
    <div className="space-y-4">
      {/* 默认设置 */}
      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="text-sm font-medium text-gray-300 mb-3">默认设置</h3>
        <div className="grid grid-cols-2 gap-3">
          {/* Provider 下拉 + 手动输入 */}
          <div>
            <label className="text-xs text-gray-400 block mb-1">默认 Provider</label>
            <div className="flex gap-1">
              <select
                value={providerNames.includes(config.defaultProvider) ? config.defaultProvider : ''}
                onChange={e => { if (e.target.value) handleProviderChange(e.target.value) }}
                className="flex-1 bg-gray-900 text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="" disabled>选择 Provider</option>
                {providerNames.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              <input
                value={config.defaultProvider}
                onChange={e => setConfig({ ...config, defaultProvider: e.target.value })}
                placeholder="或手动输入"
                className="w-32 bg-gray-900 text-sm rounded px-2 py-2 outline-none focus:ring-1 focus:ring-blue-500 text-gray-400"
              />
            </div>
          </div>

          {/* Model 下拉 + 手动输入 */}
          <div>
            <label className="text-xs text-gray-400 block mb-1">默认 Model</label>
            <div className="flex gap-1">
              <select
                value={currentModels.includes(config.defaultModel) ? config.defaultModel : ''}
                onChange={e => { if (e.target.value) setConfig({ ...config, defaultModel: e.target.value }) }}
                className="flex-1 bg-gray-900 text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="" disabled>选择 Model</option>
                {currentModels.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <input
                value={config.defaultModel}
                onChange={e => setConfig({ ...config, defaultModel: e.target.value })}
                placeholder="或手动输入"
                className="w-32 bg-gray-900 text-sm rounded px-2 py-2 outline-none focus:ring-1 focus:ring-blue-500 text-gray-400"
              />
            </div>
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-2">修改后点击"保存配置"生效（写入 ~/.zcli/config.json）</p>
      </div>

      {/* Provider 列表 */}
      {Object.entries(config.providers).map(([name, prov]) => (
        <ProviderCard key={name} name={name} provider={prov} />
      ))}

      {/* 保存按钮 */}
      <div className="flex items-center gap-3">
        <button onClick={handleSave} disabled={saving} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-50 text-sm">
          {saving ? '保存中...' : '保存配置'}
        </button>
        {error && <span className="text-red-400 text-sm">{error}</span>}
      </div>
    </div>
  )
}

// ═══ 计价规则 Tab ═══

const EMPTY_RULE: Omit<PricingRule, 'id'> = {
  provider: '', model_pattern: '', input_price: 0, output_price: 0,
  cache_read_price: 0, cache_write_price: 0, currency: 'USD',
  effective_from: new Date().toISOString().slice(0, 10), effective_to: null, source: null, priority: 0,
}

function PricingTab() {
  const toast = useToast()
  const [rules, setRules] = useState<PricingRule[]>([])
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Partial<PricingRule> & { isNew?: boolean } | null>(null)

  const loadRules = useCallback(() => {
    apiGet<{ rules: PricingRule[] }>('/api/pricing')
      .then(d => setRules(d.rules))
      .catch(e => setError(String(e)))
  }, [])

  useEffect(() => { loadRules() }, [loadRules])

  const handleDelete = useCallback(async (id: number) => {
    if (!window.confirm('确定删除这条计价规则？')) return
    try {
      await apiPost('/api/pricing/delete', { id })
      loadRules()
      toast.success('计价规则已删除')
    } catch (e) { setError(String(e)); toast.error('删除失败') }
  }, [loadRules, toast])

  const handleSave = useCallback(async () => {
    if (!editing) return
    try {
      if (editing.isNew) {
        await apiPost('/api/pricing/add', editing)
        toast.success('计价规则已添加')
      } else {
        await apiPost('/api/pricing/update', editing)
        toast.success('计价规则已更新')
      }
      setEditing(null)
      loadRules()
    } catch (e) { setError(String(e)); toast.error('保存失败') }
  }, [editing, loadRules, toast])

  const sym = (c: string) => c === 'CNY' ? '¥' : '$'

  return (
    <div className="space-y-4">
      {/* 新增按钮 */}
      <button
        onClick={() => setEditing({ ...EMPTY_RULE, isNew: true })}
        className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-500"
      >
        + 新增规则
      </button>

      {/* 编辑表单 */}
      {editing && (
        <div className="bg-gray-800 rounded-lg p-4 border border-blue-500/30">
          <h4 className="text-sm font-medium mb-3">{editing.isNew ? '新增计价规则' : '编辑计价规则'}</h4>
          <div className="grid grid-cols-3 gap-3 text-sm">
            <Field label="供应商" value={editing.provider ?? ''} onChange={v => setEditing({ ...editing, provider: v })} />
            <Field label="模型匹配" value={editing.model_pattern ?? ''} onChange={v => setEditing({ ...editing, model_pattern: v })} placeholder="如 claude-opus-4-*" />
            <Field label="币种" value={editing.currency ?? 'USD'} onChange={v => setEditing({ ...editing, currency: v })} />
            <Field label="输入价格 (/M tokens)" value={String(editing.input_price ?? 0)} onChange={v => setEditing({ ...editing, input_price: Number(v) })} type="number" />
            <Field label="输出价格 (/M tokens)" value={String(editing.output_price ?? 0)} onChange={v => setEditing({ ...editing, output_price: Number(v) })} type="number" />
            <Field label="生效日期" value={editing.effective_from ?? ''} onChange={v => setEditing({ ...editing, effective_from: v })} placeholder="YYYY-MM-DD" />
            <Field label="Cache Read (/M)" value={String(editing.cache_read_price ?? 0)} onChange={v => setEditing({ ...editing, cache_read_price: Number(v) })} type="number" />
            <Field label="Cache Write (/M)" value={String(editing.cache_write_price ?? 0)} onChange={v => setEditing({ ...editing, cache_write_price: Number(v) })} type="number" />
            <Field label="来源说明" value={editing.source ?? ''} onChange={v => setEditing({ ...editing, source: v })} placeholder="如 官网 2026-03" />
          </div>
          <div className="flex gap-2 mt-4">
            <button onClick={handleSave} className="px-3 py-1.5 bg-green-600 text-white text-sm rounded hover:bg-green-500">保存</button>
            <button onClick={() => setEditing(null)} className="px-3 py-1.5 bg-gray-700 text-gray-300 text-sm rounded hover:bg-gray-600">取消</button>
          </div>
        </div>
      )}

      {/* 规则列表 */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-400 border-b border-gray-700">
              <th className="px-3 py-2">供应商</th>
              <th className="px-3 py-2">模型匹配</th>
              <th className="px-3 py-2 text-right">输入</th>
              <th className="px-3 py-2 text-right">输出</th>
              <th className="px-3 py-2">币种</th>
              <th className="px-3 py-2">生效日期</th>
              <th className="px-3 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {rules.map(r => (
              <tr key={r.id} className="border-b border-gray-800 hover:bg-gray-800/50">
                <td className="px-3 py-2 font-mono">{r.provider}</td>
                <td className="px-3 py-2 font-mono">{r.model_pattern}</td>
                <td className="px-3 py-2 text-right">{sym(r.currency)}{r.input_price}</td>
                <td className="px-3 py-2 text-right">{sym(r.currency)}{r.output_price}</td>
                <td className="px-3 py-2">{r.currency}</td>
                <td className="px-3 py-2 text-gray-400">{r.effective_from}</td>
                <td className="px-3 py-2 space-x-2">
                  <button onClick={() => setEditing(r)} className="text-blue-400 hover:text-blue-300 text-xs">编辑</button>
                  <button onClick={() => handleDelete(r.id)} className="text-red-400 hover:text-red-300 text-xs">删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rules.length === 0 && <p className="text-gray-500 text-sm">暂无计价规则</p>}
      {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
    </div>
  )
}

function Field({ label, value, onChange, placeholder, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string
}) {
  return (
    <div>
      <label className="text-xs text-gray-400 block mb-1">{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="w-full bg-gray-900 text-sm rounded px-2 py-1.5 outline-none focus:ring-1 focus:ring-blue-500" />
    </div>
  )
}

function ProviderCard({ name, provider }: { name: string; provider: ProviderConfig }) {
  const [showKey, setShowKey] = useState(false)
  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-300">{name}</h3>
        {provider.protocol && <span className="text-xs bg-gray-700 px-2 py-0.5 rounded text-gray-400">{provider.protocol}</span>}
      </div>
      <div className="space-y-2 text-sm">
        {provider.baseURL && (
          <div><span className="text-gray-500">baseURL:</span> <span className="text-gray-300 font-mono text-xs">{provider.baseURL}</span></div>
        )}
        <div className="flex items-center gap-2">
          <span className="text-gray-500">API Key:</span>
          <span className="text-gray-300 font-mono text-xs">
            {showKey ? provider.apiKey : `${provider.apiKey.slice(0, 8)}${'•'.repeat(Math.max(0, Math.min(provider.apiKey.length - 8, 24)))}`}
          </span>
          <button onClick={() => setShowKey(!showKey)} className="text-xs text-blue-400 hover:text-blue-300">
            {showKey ? '隐藏' : '显示'}
          </button>
        </div>
        <div><span className="text-gray-500">Models:</span> <span className="text-gray-300">{provider.models.join(', ')}</span></div>
      </div>
    </div>
  )
}
