// A2A 节点端点诊断：读 lockfile 拿端口，测 well-known + RPC 路由
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dir = join(homedir(), '.ccode', 'instances')
const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'))
if (files.length === 0) {
  console.log('[无活跃 lockfile] 会话没启动或没写 lockfile')
  process.exit(0)
}

const cards = []
for (const f of files) {
  try {
    cards.push(JSON.parse(await readFile(join(dir, f), 'utf8')))
  } catch {}
}
console.log(`发现 ${cards.length} 个活跃节点:`, cards.map((c) => `${c.projectName}:${c.port}`).join(', '))

const port = cards[0].port
console.log(`\n=== 测试端口 ${port} ===`)

// 1. GET well-known
try {
  const res = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`, { signal: AbortSignal.timeout(5000) })
  console.log(`[1] GET /.well-known/agent-card.json -> ${res.status}`)
  const card = await res.json()
  console.log('    card.url:', card.url)
  console.log('    preferredTransport:', card.preferredTransport ?? '(未设置!)')
  console.log('    additionalInterfaces:', JSON.stringify(card.additionalInterfaces ?? '(未设置)'))
} catch (e) {
  console.log('[1] well-known 失败:', e.message)
}

// 2/3. POST 测路由（method:ping，命中路由返回 -32601，路径错返回 404）
for (const path of ['/', '/a2a/rpc']) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
      signal: AbortSignal.timeout(5000),
    })
    const text = await res.text()
    console.log(`[POST ${path}] -> ${res.status}  ${text.slice(0, 120)}`)
  } catch (e) {
    console.log(`[POST ${path}] 失败:`, e.message)
  }
}
