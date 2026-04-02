// web/src/utils/pca.ts

import { PCA } from 'ml-pca'

export interface Point2D {
  x: number
  y: number
  index: number  // 对应 chunks 数组的原始下标
}

/**
 * 将高维向量降维到 2D。
 *
 * @param embeddings 二维数组，每行一个向量
 * @returns 归一化到 [0, 1] 范围的 2D 坐标
 */
export function reduceTo2D(embeddings: number[][]): Point2D[] {
  if (embeddings.length === 0) return []

  // 只有 1 个点，放中心
  if (embeddings.length === 1) {
    return [{ x: 0.5, y: 0.5, index: 0 }]
  }

  const pca = new PCA(embeddings, { scale: false, center: true })
  const projected = pca.predict(embeddings, { nComponents: 2 })
  const data = projected.to2DArray()

  // 归一化到 [0, 1]（留 5% padding）
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const [x, y] of data) {
    if (x! < minX) minX = x!
    if (x! > maxX) maxX = x!
    if (y! < minY) minY = y!
    if (y! > maxY) maxY = y!
  }

  const rangeX = maxX - minX || 1
  const rangeY = maxY - minY || 1
  const padding = 0.05

  return data.map(([x, y], i) => ({
    x: padding + (1 - 2 * padding) * (x! - minX) / rangeX,
    y: padding + (1 - 2 * padding) * (y! - minY) / rangeY,
    index: i,
  }))
}
