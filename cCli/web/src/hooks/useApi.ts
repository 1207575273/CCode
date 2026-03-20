// src/hooks/useApi.ts

/**
 * REST API 请求封装。
 * 所有请求成功后打印日志到控制台，方便调试。
 */

const BASE = ''

export async function apiGet<T>(path: string): Promise<T> {
  console.log(`[API] GET ${path}`)
  const resp = await fetch(`${BASE}${path}`)
  if (!resp.ok) {
    console.error(`[API] GET ${path} → ${resp.status}`)
    throw new Error(`API ${path}: ${resp.status}`)
  }
  const data = await resp.json() as T
  console.log(`[API] GET ${path} → OK`, data)
  return data
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  console.log(`[API] POST ${path}`, body)
  const resp = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    console.error(`[API] POST ${path} → ${resp.status}`)
    throw new Error(`API ${path}: ${resp.status}`)
  }
  const data = await resp.json() as T
  console.log(`[API] POST ${path} → OK`, data)
  return data
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  console.log(`[API] PUT ${path}`, body)
  const resp = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    console.error(`[API] PUT ${path} → ${resp.status}`)
    throw new Error(`API ${path}: ${resp.status}`)
  }
  const data = await resp.json() as T
  console.log(`[API] PUT ${path} → OK`, data)
  return data
}

export async function apiDelete<T>(path: string): Promise<T> {
  console.log(`[API] DELETE ${path}`)
  const resp = await fetch(`${BASE}${path}`, { method: 'DELETE' })
  if (!resp.ok) {
    console.error(`[API] DELETE ${path} → ${resp.status}`)
    throw new Error(`API ${path}: ${resp.status}`)
  }
  const data = await resp.json() as T
  console.log(`[API] DELETE ${path} → OK`, data)
  return data
}
