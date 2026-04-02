// web/src/components/MemoryPanel.tsx

import { useState, useEffect, useCallback } from 'react'
import { apiGet } from '../hooks/useApi'
import { ScatterPlot } from './ScatterPlot'
import { reduceTo2D } from '../utils/pca'
import type { Point2D } from '../utils/pca'
import type { ChunkMeta } from './ScatterPlot'
import type { MemoryVectorsResponse } from '../types'

interface MemoryPanelProps {
  open: boolean
  onClose: () => void
}

export function MemoryPanel({ open, onClose }: MemoryPanelProps) {
  const [data, setData] = useState<MemoryVectorsResponse | null>(null)
  const [points, setPoints] = useState<Point2D[]>([])
  const [metas, setMetas] = useState<ChunkMeta[]>([])
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const resp = await apiGet<MemoryVectorsResponse>('/api/memory/vectors')
      setData(resp)

      // PCA 降维
      const embeddings = resp.chunks.map(c => c.embedding).filter(e => e.length > 0)
      if (embeddings.length > 0) {
        const pts = reduceTo2D(embeddings)
        setPoints(pts)
      } else {
        setPoints([])
      }

      // 元信息
      setMetas(resp.chunks.map(c => ({
        id: c.id,
        entryId: c.entryId,
        title: c.title,
        scope: c.scope,
        type: c.type,
        tags: c.tags,
        chunkText: c.chunkText,
      })))

      setSelectedIndex(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  // 打开时加载数据
  useEffect(() => {
    if (open) loadData()
  }, [open, loadData])

  // ESC 关闭
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  const selected = selectedIndex !== null ? metas[selectedIndex] : null

  return (
    <>
      {/* 遮罩 */}
      {open && (
        <div
          className="fixed inset-0 bg-black/30 z-40 transition-opacity"
          onClick={onClose}
        />
      )}

      {/* 抽屉面板 */}
      <div className={`fixed top-0 right-0 h-full w-[400px] bg-gray-900 border-l border-gray-700 z-50
        transform transition-transform duration-300 ${open ? 'translate-x-0' : 'translate-x-full'}`}>

        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <span className="text-sm font-semibold text-gray-200">记忆全景</span>
          <div className="flex items-center gap-2">
            <button
              onClick={loadData}
              className="text-xs px-2 py-1 rounded bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors"
              title="刷新数据"
            >
              刷新
            </button>
            <button
              onClick={onClose}
              className="text-xs px-2 py-1 rounded bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors"
            >
              关闭
            </button>
          </div>
        </div>

        {loading && (
          <div className="flex items-center justify-center h-32 text-gray-500 text-sm">加载中...</div>
        )}

        {error && (
          <div className="px-4 py-3 text-red-400 text-xs">{error}</div>
        )}

        {!loading && data && (
          <div className="flex flex-col h-[calc(100%-49px)] overflow-hidden">

            {/* System Prompt 概览 */}
            <div className="px-4 py-3 border-b border-gray-800">
              <div className="text-xs text-gray-500 mb-2">
                System Prompt — 约 {data.systemPrompt.totalTokens.toLocaleString()} tokens
              </div>
              <div className="flex flex-wrap gap-2">
                {data.systemPrompt.sections.map((s, i) => (
                  <div key={i} className="px-2 py-1 rounded bg-gray-800 text-xs">
                    <span className="text-gray-400">{s.name}</span>
                    <span className="ml-1 text-gray-500">{s.tokens.toLocaleString()}</span>
                  </div>
                ))}
                {data.systemPrompt.sections.length === 0 && (
                  <span className="text-xs text-gray-600">尚未构建</span>
                )}
              </div>
            </div>

            {/* 散点图 */}
            <div className="flex-1 min-h-0 px-2 py-2">
              {points.length > 0 ? (
                <div className="w-full h-full rounded border border-gray-800 overflow-hidden">
                  <ScatterPlot
                    points={points}
                    metas={metas}
                    onSelect={setSelectedIndex}
                    selectedIndex={selectedIndex}
                  />
                </div>
              ) : (
                <div className="flex items-center justify-center h-full text-gray-600 text-xs">
                  暂无向量数据（未配置 Embedding 或无记忆）
                </div>
              )}
            </div>

            {/* 选中详情 */}
            {selected && (
              <div className="px-4 py-3 border-t border-gray-800 max-h-[200px] overflow-y-auto">
                <div className="text-xs font-medium text-gray-200 mb-1 truncate">{selected.title}</div>
                <div className="flex gap-2 mb-2 flex-wrap">
                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                    selected.scope === 'global' ? 'bg-blue-900/50 text-blue-300' : 'bg-green-900/50 text-green-300'
                  }`}>
                    {selected.scope}
                  </span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">{selected.type}</span>
                  {selected.tags.map(tag => (
                    <span key={tag} className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-500">
                      {tag}
                    </span>
                  ))}
                </div>
                <div className="text-xs text-gray-400 leading-relaxed whitespace-pre-wrap">
                  {selected.chunkText.slice(0, 300)}
                  {selected.chunkText.length > 300 && '...'}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}
