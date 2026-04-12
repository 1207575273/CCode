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
  visionModels?: string[]
}

interface CCodeConfig {
  defaultProvider: string
  defaultModel: string
  subAgentModel?: string
  providers: Record<string, ProviderConfig>
  memory?: {
    enabled?: boolean
    embedding?: {
      apiKey?: string
      baseURL?: string
      model?: string
      dimension?: number
    }
  }
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

// ═══ Memory 配置卡片 ═══

function MemoryCard({ config, setConfig, toast }: {
  config: CCodeConfig
  setConfig: (c: CCodeConfig) => void
  toast: ReturnType<typeof useToast>
}) {
  const [showEmbKey, setShowEmbKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)

  const handleTest = useCallback(async () => {
    const emb = config.memory?.embedding
    if (!emb?.apiKey || !emb?.baseURL || !emb?.model) {
      toast.error('请先填写完整的 Embedding 配置')
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const res = await apiPost<{ success: boolean; dimension?: number; error?: string }>(
        '/api/settings/test-embedding',
        { apiKey: emb.apiKey, baseURL: emb.baseURL, model: emb.model },
      )
      if (res.success) {
        setTestResult({ ok: true, msg: `连通成功（维度: ${res.dimension ?? '未知'}）` })
        toast.success('Embedding API 连通成功')
      } else {
        setTestResult({ ok: false, msg: res.error ?? '未知错误' })
        toast.error('Embedding API 连通失败')
      }
    } catch (e) {
      setTestResult({ ok: false, msg: String(e) })
      toast.error('测试请求失败')
    }
    setTesting(false)
  }, [config.memory?.embedding, toast])

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-300">Memory 记忆系统</h3>
        <label className="flex items-center gap-2 cursor-pointer">
          <span className="text-xs text-gray-400">{config.memory?.enabled ? '已启用' : '未启用'}</span>
          <input
            type="checkbox"
            checked={config.memory?.enabled ?? false}
            onChange={e => setConfig({
              ...config,
              memory: { ...config.memory, enabled: e.target.checked },
            })}
            className="w-4 h-4 rounded bg-gray-900 border-gray-600 text-blue-500 focus:ring-blue-500 cursor-pointer"
          />
        </label>
      </div>

      {config.memory?.enabled && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Embedding API Key</label>
              <div className="flex gap-1">
                <input
                  type={showEmbKey ? 'text' : 'password'}
                  value={config.memory?.embedding?.apiKey ?? ''}
                  onChange={e => setConfig({
                    ...config,
                    memory: {
                      ...config.memory,
                      enabled: true,
                      embedding: { ...config.memory?.embedding, apiKey: e.target.value },
                    },
                  })}
                  placeholder="sk-xxx"
                  className="flex-1 bg-gray-900 text-sm font-mono rounded px-3 py-2 outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button onClick={() => setShowEmbKey(!showEmbKey)} className="px-2 text-xs text-blue-400 hover:text-blue-300 shrink-0">
                  {showEmbKey ? '隐藏' : '显示'}
                </button>
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Base URL</label>
              <input
                value={config.memory?.embedding?.baseURL ?? ''}
                onChange={e => setConfig({
                  ...config,
                  memory: {
                    ...config.memory,
                    enabled: true,
                    embedding: { ...config.memory?.embedding, baseURL: e.target.value },
                  },
                })}
                placeholder="https://open.bigmodel.cn/api/coding/paas/v4"
                className="w-full bg-gray-900 text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Embedding Model</label>
              <input
                value={config.memory?.embedding?.model ?? ''}
                onChange={e => setConfig({
                  ...config,
                  memory: {
                    ...config.memory,
                    enabled: true,
                    embedding: { ...config.memory?.embedding, model: e.target.value },
                  },
                })}
                placeholder="embedding-3"
                className="w-full bg-gray-900 text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">向量维度</label>
              <input
                type="number"
                value={config.memory?.embedding?.dimension ?? 1024}
                onChange={e => setConfig({
                  ...config,
                  memory: {
                    ...config.memory,
                    enabled: true,
                    embedding: { ...config.memory?.embedding, dimension: parseInt(e.target.value) || 1024 },
                  },
                })}
                placeholder="1024"
                className="w-full bg-gray-900 text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>
          <div className="flex items-center gap-3 mt-1">
            <button
              onClick={handleTest}
              disabled={testing}
              className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 rounded transition-colors"
            >
              {testing ? '测试中...' : '测试连通性'}
            </button>
            {testResult && (
              <span className={`text-xs ${testResult.ok ? 'text-green-400' : 'text-red-400'}`}>
                {testResult.msg}
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500">支持 OpenAI 兼容的 Embedding API（GLM、DeepSeek、OpenAI 等）。未配置时降级为纯 BM25 关键词检索</p>
        </div>
      )}
    </div>
  )
}

// ═══ Provider 配置 Tab ═══

function ProvidersTab() {
  const toast = useToast()
  const [config, setConfig] = useState<CCodeConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    apiGet<{ config: CCodeConfig }>('/api/settings')
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

        {/* SubAgent 默认模型 */}
        <div className="mt-3">
          <label className="text-xs text-gray-400 block mb-1">SubAgent 默认 Model（可选）</label>
          <div className="flex gap-1">
            <select
              value={config.subAgentModel ?? ''}
              onChange={e => setConfig({ ...config, ...(e.target.value ? { subAgentModel: e.target.value } : { subAgentModel: undefined }) })}
              className="flex-1 bg-gray-900 text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">继承主 Agent 模型</option>
              {currentModels.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <input
              value={config.subAgentModel ?? ''}
              onChange={e => setConfig({ ...config, ...(e.target.value ? { subAgentModel: e.target.value } : { subAgentModel: undefined }) })}
              placeholder="或手动输入"
              className="w-32 bg-gray-900 text-sm rounded px-2 py-2 outline-none focus:ring-1 focus:ring-blue-500 text-gray-400"
            />
          </div>
          <p className="text-xs text-gray-500 mt-1">子 Agent 使用的模型（仅限当前 Provider 下的模型）。不填则继承主 Agent 模型，可用于降低成本</p>
        </div>

        <p className="text-xs text-gray-500 mt-2">修改后点击"保存配置"生效（写入 ~/.ccode/config.json）</p>
      </div>

      {/* Memory / Embedding 配置 */}
      <MemoryCard config={config} setConfig={setConfig} toast={toast} />

      {/* 新增供应商 */}
      <AddProviderButton onAdd={(name) => {
        if (config.providers[name]) return
        setConfig({
          ...config,
          providers: { ...config.providers, [name]: { apiKey: '', models: [] } },
        })
      }} />

      {/* Provider 列表 */}
      {Object.entries(config.providers).map(([name, prov]) => (
        <ProviderCard
          key={name}
          name={name}
          provider={prov}
          onChange={(updated) => {
            setConfig({ ...config, providers: { ...config.providers, [name]: updated } })
          }}
          onDelete={() => {
            const { [name]: _, ...rest } = config.providers
            setConfig({ ...config, providers: rest })
          }}
        />
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

function AddProviderButton({ onAdd }: { onAdd: (name: string) => void }) {
  const [show, setShow] = useState(false)
  const [name, setName] = useState('')

  const handleAdd = () => {
    const n = name.trim()
    if (!n) return
    onAdd(n)
    setName('')
    setShow(false)
  }

  if (!show) {
    return (
      <button onClick={() => setShow(true)} className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-500">
        + 新增供应商
      </button>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
        placeholder="供应商名称（如 deepseek）"
        className="bg-gray-900 text-sm rounded px-3 py-1.5 outline-none focus:ring-1 focus:ring-blue-500"
        autoFocus
      />
      <button onClick={handleAdd} className="px-3 py-1.5 bg-green-600 text-white text-sm rounded hover:bg-green-500">确认</button>
      <button onClick={() => { setShow(false); setName('') }} className="px-3 py-1.5 bg-gray-700 text-gray-300 text-sm rounded hover:bg-gray-600">取消</button>
    </div>
  )
}

function ProviderCard({ name, provider, onChange, onDelete }: {
  name: string
  provider: ProviderConfig
  onChange: (updated: ProviderConfig) => void
  onDelete: () => void
}) {
  const [showKey, setShowKey] = useState(false)
  const [newModel, setNewModel] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)
  // 选中的模型（用于测试连通性），默认选第一个
  const [selectedModel, setSelectedModel] = useState<string | null>(provider.models[0] ?? null)
  // 拖拽排序状态
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)

  // 测试指定模型的连通性
  const handleTest = async (model?: string) => {
    const targetModel = model ?? selectedModel ?? provider.models[0]
    if (!targetModel) return
    setTesting(true)
    setTestResult(null)
    try {
      const res = await apiPost<{ success: boolean; model?: string; durationMs?: number; error?: string }>(
        '/api/settings/test-provider',
        { provider: name, config: provider, model: targetModel }
      )
      if (res.success) {
        setTestResult({ ok: true, msg: `✅ ${res.model} 连通成功（${res.durationMs}ms）` })
      } else {
        setTestResult({ ok: false, msg: `❌ ${targetModel}: ${res.error ?? '未知错误'}` })
      }
    } catch (e) {
      setTestResult({ ok: false, msg: `❌ ${targetModel}: ${String(e)}` })
    }
    setTesting(false)
  }

  const addModel = () => {
    const m = newModel.trim()
    if (!m || provider.models.includes(m)) return
    onChange({ ...provider, models: [...provider.models, m] })
    // 新增后自动选中
    setSelectedModel(m)
    setNewModel('')
  }

  const removeModel = (model: string) => {
    const updated = provider.models.filter(m => m !== model)
    onChange({ ...provider, models: updated })
    // 删除选中项时自动选第一个
    if (selectedModel === model) {
      setSelectedModel(updated[0] ?? null)
    }
  }

  // 拖拽排序：交换位置
  const handleDragEnd = () => {
    if (dragIdx !== null && dragOverIdx !== null && dragIdx !== dragOverIdx) {
      const models = [...provider.models]
      const [moved] = models.splice(dragIdx, 1)
      models.splice(dragOverIdx, 0, moved!)
      onChange({ ...provider, models })
    }
    setDragIdx(null)
    setDragOverIdx(null)
  }

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      {/* 头部：名称 + 协议 + 操作按钮 */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-gray-300">{name}</h3>
          <select
            value={provider.protocol ?? (name === 'anthropic' ? 'anthropic' : 'openai')}
            onChange={e => onChange({ ...provider, protocol: e.target.value })}
            className="text-xs bg-gray-700 px-2 py-0.5 rounded text-gray-400 outline-none"
          >
            <option value="openai">openai</option>
            <option value="anthropic">anthropic</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => handleTest()} disabled={testing || !provider.models.length}
            className="px-2 py-1 text-xs bg-emerald-700 text-white rounded hover:bg-emerald-600 disabled:opacity-50"
            title={selectedModel ? `测试 ${selectedModel}` : '请先添加模型'}>
            {testing ? '测试中...' : `测试${selectedModel ? ` ${selectedModel}` : ''}`}
          </button>
          <button onClick={() => { if (window.confirm(`确定删除供应商 "${name}"？`)) onDelete() }}
            className="px-2 py-1 text-xs bg-red-700/60 text-red-300 rounded hover:bg-red-600/60">
            删除
          </button>
        </div>
      </div>

      {/* 测试结果 */}
      {testResult && (
        <div className={`text-xs mb-3 px-2 py-1 rounded ${testResult.ok ? 'bg-emerald-900/30 text-emerald-400' : 'bg-red-900/30 text-red-400'}`}>
          {testResult.msg}
        </div>
      )}

      {/* 编辑字段 */}
      <div className="space-y-3 text-sm">
        {/* API Key */}
        <div>
          <label className="text-xs text-gray-400 block mb-1">API Key</label>
          <div className="flex gap-1">
            <input
              type={showKey ? 'text' : 'password'}
              value={provider.apiKey}
              onChange={e => onChange({ ...provider, apiKey: e.target.value })}
              placeholder="填入 API Key"
              className="flex-1 bg-gray-900 text-sm font-mono rounded px-2 py-1.5 outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button onClick={() => setShowKey(!showKey)} className="px-2 text-xs text-blue-400 hover:text-blue-300 shrink-0">
              {showKey ? '隐藏' : '显示'}
            </button>
          </div>
        </div>

        {/* Base URL */}
        <div>
          <label className="text-xs text-gray-400 block mb-1">Base URL（可选）</label>
          <input
            value={provider.baseURL ?? ''}
            onChange={e => onChange({ ...provider, baseURL: e.target.value || undefined })}
            placeholder="如 https://open.bigmodel.cn/api/coding/paas/v4"
            className="w-full bg-gray-900 text-sm font-mono rounded px-2 py-1.5 outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        {/* Models — 可选中 + 可拖拽排序 */}
        <div>
          <label className="text-xs text-gray-400 block mb-1">
            模型列表
            <span className="text-gray-500 ml-2">点击选中测试 · 拖拽排序 · 首位为默认模型 · 👁 切换图片理解</span>
          </label>
          <div className="flex flex-wrap gap-1 mb-1 min-h-[28px]">
            {provider.models.map((m, idx) => {
              const isSelected = m === selectedModel
              const isDragging = idx === dragIdx
              const isDragOver = idx === dragOverIdx && dragIdx !== null && dragIdx !== idx
              return (
                <span
                  key={m}
                  draggable
                  onDragStart={() => setDragIdx(idx)}
                  onDragOver={(e) => { e.preventDefault(); setDragOverIdx(idx) }}
                  onDragEnd={handleDragEnd}
                  onClick={() => setSelectedModel(m)}
                  onDoubleClick={() => handleTest(m)}
                  className={[
                    'inline-flex items-center gap-1 text-xs px-2 py-1 rounded cursor-pointer select-none transition-all',
                    isSelected
                      ? 'bg-blue-600/40 text-blue-300 ring-1 ring-blue-500/60'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600',
                    isDragging ? 'opacity-40' : '',
                    isDragOver ? 'ring-1 ring-yellow-400/60' : '',
                  ].join(' ')}
                  title={`点击选中 · 双击测试 · 拖拽排序${idx === 0 ? ' · 当前为默认模型' : ''}`}
                >
                  {/* 拖拽手柄 */}
                  <span className="text-gray-500 cursor-grab active:cursor-grabbing mr-0.5">⠿</span>
                  {idx === 0 && <span className="text-yellow-500 text-[10px]" title="默认模型">★</span>}
                  {m}
                  {/* vision 切换：点击将模型加入/移出 visionModels */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      const visionModels = provider.visionModels ?? []
                      const isVision = visionModels.includes(m)
                      const updated = isVision
                        ? visionModels.filter(v => v !== m)
                        : [...visionModels, m]
                      onChange({ ...provider, visionModels: updated })
                    }}
                    className={`text-xs ${
                      (provider.visionModels ?? []).includes(m)
                        ? 'text-blue-400 hover:text-blue-300'
                        : 'text-gray-600 hover:text-gray-400'
                    }`}
                    title={`${(provider.visionModels ?? []).includes(m) ? '已启用' : '未启用'}图片理解`}
                  >
                    {(provider.visionModels ?? []).includes(m) ? '👁' : '🚫'}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); removeModel(m) }}
                    className="text-gray-500 hover:text-red-400 ml-0.5"
                  >×</button>
                </span>
              )
            })}
          </div>
          <div className="flex gap-1">
            <input
              value={newModel}
              onChange={e => setNewModel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addModel() } }}
              placeholder="输入模型名称，回车添加"
              className="flex-1 bg-gray-900 text-xs font-mono rounded px-2 py-1.5 outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button onClick={addModel} className="px-2 py-1 text-xs bg-gray-700 text-gray-300 rounded hover:bg-gray-600">添加</button>
          </div>
        </div>
      </div>
    </div>
  )
}
