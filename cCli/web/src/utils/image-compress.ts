/**
 * 图片压缩：最长边 ≤ 2048px，统一输出 JPEG（quality 0.85）
 */
const MAX_DIMENSION = 2048
const JPEG_QUALITY = 0.85

export async function compressImage(blob: Blob): Promise<Blob> {
  const img = await createImageBitmap(blob)
  const { width, height } = img
  const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height))
  const targetW = Math.round(width * scale)
  const targetH = Math.round(height * scale)

  const canvas = new OffscreenCanvas(targetW, targetH)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, targetW, targetH)
  return canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
}
