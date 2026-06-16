// 受控验证：拉起一个 A2A 节点，探测它实际暴露的端点是否符合 A2A 标准
// 运行：CCODE_HOME=<临时目录> npx tsx scripts/verify-a2a-endpoints.ts
import { startA2ANode } from '../src/a2a/node-server.js'
import type { AgentEvent } from '../src/core/agent-loop.js'

const handle = startA2ANode({
  sessionId: 'verify-0001-aaaa-bbbb',
  cwd: process.cwd(),
  projectName: 'verify',
  version: '0.0.0-test',
  getToolNames: () => ['bash', 'read_file', 'edit_file'],
  runLoop: async function* (): AsyncGenerator<AgentEvent> {
    yield { type: 'text', text: 'pong' } as AgentEvent
  },
})

const base = handle.baseUrl
const rpc = async (method: string, params: Record<string, unknown> = {}) => {
  const res = await fetch(base + '/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return { status: res.status, body: await res.json() }
}

console.log('=== baseUrl ===', base)

// 1. 标准发现端点
const cardRes = await fetch(`${base}/.well-known/agent-card.json`)
const card = await cardRes.json() as Record<string, unknown>
console.log('\n[1] GET /.well-known/agent-card.json ->', cardRes.status)
console.log('    protocolVersion :', card['protocolVersion'])
console.log('    preferredTransport:', card['preferredTransport'] ?? '(未设置)')
console.log('    capabilities    :', JSON.stringify(card['capabilities']))
console.log('    url             :', card['url'])
console.log('    defaultInput/Output:', JSON.stringify(card['defaultInputModes']), JSON.stringify(card['defaultOutputModes']))
console.log('    skills(count)   :', Array.isArray(card['skills']) ? card['skills'].length : 'n/a')

// 2. 标准消息端点 message/send（捕获真实 taskId）
const send = await rpc('message/send', { message: { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'ping' }] } })
const realTaskId = (send.body as { result?: { id?: string } }).result?.id ?? ''
console.log('\n[2] POST / message/send ->', send.status, '| taskId =', realTaskId)

// 3. 用真实 taskId 查 tasks/get（应命中）
const get = await rpc('tasks/get', { id: realTaskId })
const getResult = (get.body as { result?: { id?: string; status?: { state?: string } } }).result
console.log('\n[3] tasks/get <真实 taskId> ->', getResult ? `OK id=${getResult.id} state=${getResult.status?.state}` : JSON.stringify(get.body))

// 3b. tasks/cancel 已终态任务（应 -32002 not cancelable）
const cancelTerminal = await rpc('tasks/cancel', { id: realTaskId })
const ctErr = (cancelTerminal.body as { error?: { code: number } }).error
console.log('[3b] tasks/cancel <已完成任务> ->', ctErr ? `error ${ctErr.code} (not-cancelable)` : 'OK')

// 3c. 未知 taskId（应 -32001 not found）
const getUnknown = await rpc('tasks/get', { id: 'no-such-task' })
const guErr = (getUnknown.body as { error?: { code: number } }).error
console.log('[3c] tasks/get <未知 taskId> ->', guErr ? `error ${guErr.code} (not-found)` : 'OK')

// 4. 兼容旧路径 /a2a/rpc
const legacy = await fetch(base + '/a2a/rpc', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'message/send', params: { message: { kind: 'message', messageId: 'm2', role: 'user', parts: [{ kind: 'text', text: 'ping' }] } } }),
})
console.log('\n[4] POST /a2a/rpc (旧路径) ->', legacy.status)

// 5. 非标准 CCode 内部端点
const inbound = await fetch(`${base}/a2a/inbound-activity`)
console.log('\n[5] GET /a2a/inbound-activity (CCode 自定义) ->', inbound.status, JSON.stringify(await inbound.json()))

handle.stop()
process.exit(0)
