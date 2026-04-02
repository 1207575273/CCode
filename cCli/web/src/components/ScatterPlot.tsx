// web/src/components/ScatterPlot.tsx

import { useRef, useEffect, useState, useCallback } from 'react'
import type { Point2D } from '../utils/pca'

/** chunk 元信息（用于着色和详情展示） */
export interface ChunkMeta {
  id: string
  entryId: string
  title: string
  scope: 'global' | 'project'
  type: string
  tags: string[]
  chunkText: string
}

interface ScatterPlotProps {
  points: Point2D[]
  metas: ChunkMeta[]
  onSelect: (index: number | null) => void
  selectedIndex: number | null
}

const COLORS = {
  global: '#60a5fa',    // blue-400
  project: '#4ade80',   // green-400
  selected: '#facc15',  // yellow-400
  related: '#fb923c',   // orange-400
}

const POINT_RADIUS = 5
const HIT_RADIUS = 10

export function ScatterPlot({ points, metas, onSelect, selectedIndex }: ScatterPlotProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  // 视图变换状态
  const viewRef = useRef({ offsetX: 0, offsetY: 0, scale: 1 })
  const dragRef = useRef<{ startX: number; startY: number; startOffsetX: number; startOffsetY: number } | null>(null)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    canvas.width = w * dpr
    canvas.height = h * dpr
    ctx.scale(dpr, dpr)

    ctx.clearRect(0, 0, w, h)

    const { offsetX, offsetY, scale } = viewRef.current

    // 坐标转换：归一化 [0,1] → canvas 像素
    const toCanvasX = (nx: number) => (nx * w) * scale + offsetX
    const toCanvasY = (ny: number) => (ny * h) * scale + offsetY

    // 找出高亮的 entryId（选中或 hover）
    const selectedEntryId = selectedIndex !== null ? metas[selectedIndex]?.entryId : null
    const hoveredEntryId = hoveredIndex !== null ? metas[hoveredIndex]?.entryId : null
    const highlightEntryId = selectedEntryId ?? hoveredEntryId

    // 画同 entry chunk 之间的连线
    if (highlightEntryId) {
      const relatedPoints = points.filter((_, i) => metas[i]?.entryId === highlightEntryId)
      if (relatedPoints.length > 1) {
        ctx.beginPath()
        ctx.strokeStyle = COLORS.related
        ctx.lineWidth = 1
        ctx.setLineDash([4, 4])
        ctx.moveTo(toCanvasX(relatedPoints[0]!.x), toCanvasY(relatedPoints[0]!.y))
        for (let i = 1; i < relatedPoints.length; i++) {
          ctx.lineTo(toCanvasX(relatedPoints[i]!.x), toCanvasY(relatedPoints[i]!.y))
        }
        ctx.stroke()
        ctx.setLineDash([])
      }
    }

    // 画点
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!
      const meta = metas[i]!
      const cx = toCanvasX(p.x)
      const cy = toCanvasY(p.y)

      const isSelected = i === selectedIndex
      const isHovered = i === hoveredIndex
      const isRelated = highlightEntryId !== null && meta.entryId === highlightEntryId

      ctx.beginPath()
      ctx.arc(cx, cy, isSelected || isHovered ? POINT_RADIUS + 2 : POINT_RADIUS, 0, Math.PI * 2)
      ctx.fillStyle = isSelected ? COLORS.selected
        : isRelated ? COLORS.related
        : COLORS[meta.scope] ?? COLORS.global
      ctx.fill()

      if (isSelected || isHovered) {
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 2
        ctx.stroke()
      }
    }

    // 图例
    ctx.font = '11px sans-serif'
    const legendY = h - 16
    ctx.fillStyle = COLORS.global
    ctx.fillRect(8, legendY, 10, 10)
    ctx.fillStyle = '#9ca3af'
    ctx.fillText('global', 22, legendY + 9)

    ctx.fillStyle = COLORS.project
    ctx.fillRect(70, legendY, 10, 10)
    ctx.fillStyle = '#9ca3af'
    ctx.fillText('project', 84, legendY + 9)
  }, [points, metas, selectedIndex, hoveredIndex])

  useEffect(() => { draw() }, [draw])

  // 找到鼠标下的点
  const hitTest = useCallback((clientX: number, clientY: number): number | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const mx = clientX - rect.left
    const my = clientY - rect.top
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    const { offsetX, offsetY, scale } = viewRef.current

    // 从后往前遍历（后绘制的在上层）
    for (let i = points.length - 1; i >= 0; i--) {
      const p = points[i]!
      const cx = (p.x * w) * scale + offsetX
      const cy = (p.y * h) * scale + offsetY
      const dx = mx - cx, dy = my - cy
      if (dx * dx + dy * dy <= HIT_RADIUS * HIT_RADIUS) return i
    }
    return null
  }, [points])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragRef.current) {
      const { startX, startY, startOffsetX, startOffsetY } = dragRef.current
      viewRef.current.offsetX = startOffsetX + (e.clientX - startX)
      viewRef.current.offsetY = startOffsetY + (e.clientY - startY)
      draw()
      return
    }
    const hit = hitTest(e.clientX, e.clientY)
    setHoveredIndex(hit)
  }, [hitTest, draw])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      startOffsetX: viewRef.current.offsetX, startOffsetY: viewRef.current.offsetY,
    }
  }, [])

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    const wasDrag = dragRef.current &&
      (Math.abs(e.clientX - dragRef.current.startX) > 3 || Math.abs(e.clientY - dragRef.current.startY) > 3)
    dragRef.current = null
    if (!wasDrag) {
      const hit = hitTest(e.clientX, e.clientY)
      onSelect(hit === selectedIndex ? null : hit)
    }
  }, [hitTest, onSelect, selectedIndex])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
    const v = viewRef.current
    v.offsetX = mx - (mx - v.offsetX) * factor
    v.offsetY = my - (my - v.offsetY) * factor
    v.scale *= factor
    draw()
  }, [draw])

  const handleDoubleClick = useCallback(() => {
    viewRef.current = { offsetX: 0, offsetY: 0, scale: 1 }
    onSelect(null)
    draw()
  }, [draw, onSelect])

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full cursor-crosshair"
      onMouseMove={handleMouseMove}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onWheel={handleWheel}
      onDoubleClick={handleDoubleClick}
    />
  )
}
