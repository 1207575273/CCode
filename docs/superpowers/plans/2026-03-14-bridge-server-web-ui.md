# Bridge Server + Web UI 实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 CLI 进程内嵌 Bridge Server（EventBus + Hono + WebSocket），实现 CLI 和 Web 双向实时对话同步，Web 端为 React SPA（dashboard-ui/）。

**Architecture:** EventBus 做进程内事件总线，AgentLoop 的 AgentEvent 广播到 CLI（Ink）和 Web（WebSocket）两个消费者。Web 端输入通过 WebSocket → EventBus → useChat.submit() 回流到 AgentLoop。Hono 提供 HTTP + WebSocket 服务，React SPA 由 Vite 构建。

**Tech Stack:** Hono (HTTP + WebSocket), React 18 + Vite + TypeScript (前端), Tailwind CSS (样式), react-markdown + rehype-highlight (Markdown 渲染), ws (Node WebSocket)

---

## Chunk 1: EventBus 核心 + 测试

### Task 1: EventBus 实现

**Files:**
- Create: `zCli/src/core/event-bus.ts`
- Test: `zCli/tests/unit/core/event-bus.test.ts`

- [ ] **Step 1: 写 EventBus 测试**

```typescript
// tests/unit/core/event-bus.test.ts
import { describe, it, expect, vi } from 'vitest'
import { EventBus } from '@core/event-bus.js'
import type { BusEvent } from '@core/event-bus.js'

describe('EventBus', () => {
  it('should_broadcast_event_to_all_subscribers', () => {
    const bus = new EventBus()
    const handler1 = vi.fn()
    const handler2 = vi.fn()
    bus.on(handler1)
    bus.on(handler2)

    const event: BusEvent = { type: 'user_input', text: 'hello', source: 'cli' }
    bus.emit(event)

    expect(handler1).toHaveBeenCalledWith(event)
    expect(handler2).toHaveBeenCalledWith(event)
  })

  it('should_unsubscribe_when_off_called', () => {
    const bus = new EventBus()
    const handler = vi.fn()
    const off = bus.on(handler)

    bus.emit({ type: 'user_input', text: 'a', source: 'cli' })
    expect(handler).toHaveBeenCalledTimes(1)

    off()
    bus.emit({ type: 'user_input', text: 'b', source: 'cli' })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('should_filter_by_event_type', () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.onType('user_input', handler)

    bus.emit({ type: 'user_input', text: 'hello', source: 'cli' })
    bus.emit({ type: 'text', text: 'world' })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ type: 'user_input', text: 'hello', source: 'cli' })
  })

  it('should_not_throw_when_handler_errors', () => {
    const bus = new EventBus()
    bus.on(() => { throw new Error('boom') })
    const handler2 = vi.fn()
    bus.on(handler2)

    // 第一个 handler 抛错不影响第二个
    bus.emit({ type: 'user_input', text: 'hello', source: 'cli' })
    expect(handler2).toHaveBeenCalledTimes(1)
  })

  it('should_track_connected_clients', () => {
    const bus = new EventBus()
    expect(bus.getClients()).toHaveLength(0)

    bus.emit({ type: 'client_connect', clientId: 'web-1', clientType: 'web' })
    expect(bus.getClients()).toHaveLength(1)
    expect(bus.getClients()[0]).toEqual({ clientId: 'web-1', clientType: 'web' })

    bus.emit({ type: 'client_disconnect', clientId: 'web-1' })
    expect(bus.getClients()).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd zCli && npx vitest run tests/unit/core/event-bus.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 EventBus**

```typescript
// src/core/event-bus.ts

import type { AgentEvent } from './agent-loop.js'

/** Bridge 层扩展事件 */
export type BridgeEvent =
  | { type: 'user_input'; text: string; source: 'cli' | 'web' }
  | { type: 'permission_response'; allow: boolean; source: 'cli' | 'web' }
  | { type: 'client_connect'; clientId: string; clientType: 'cli' | 'web' }
  | { type: 'client_disconnect'; clientId: string }

/** EventBus 传输的所有事件类型 */
export type BusEvent = AgentEvent | BridgeEvent

/** 已连接客户端信息 */
interface ConnectedClient {
  clientId: string
  clientType: 'cli' | 'web'
}

type Handler = (event: BusEvent) => void

/**
 * 进程内事件总线 — CLI 和 Web 的双向广播中枢。
 *
 * - AgentLoop 产出的 AgentEvent → 广播到 CLI (Ink) + Web (WebSocket)
 * - Web 端用户输入 → 路由回 useChat.submit()
 * - 单例使用，CLI 进程生命周期内存在
 */
export class EventBus {
  readonly #handlers = new Set<Handler>()
  readonly #clients: ConnectedClient[] = []

  /** 订阅所有事件，返回取消订阅函数 */
  on(handler: Handler): () => void {
    this.#handlers.add(handler)
    return () => { this.#handlers.delete(handler) }
  }

  /** 订阅特定类型的事件 */
  onType<T extends BusEvent['type']>(
    type: T,
    handler: (event: Extract<BusEvent, { type: T }>) => void,
  ): () => void {
    return this.on((event) => {
      if (event.type === type) {
        handler(event as Extract<BusEvent, { type: T }>)
      }
    })
  }

  /** 发布事件（同步广播给所有订阅者） */
  emit(event: BusEvent): void {
    // 维护客户端列表
    if (event.type === 'client_connect') {
      this.#clients.push({ clientId: event.clientId, clientType: event.clientType })
    } else if (event.type === 'client_disconnect') {
      const idx = this.#clients.findIndex(c => c.clientId === event.clientId)
      if (idx !== -1) this.#clients.splice(idx, 1)
    }

    for (const handler of this.#handlers) {
      try {
        handler(event)
      } catch {
        // 单个 handler 异常不影响其他订阅者
      }
    }
  }

  /** 获取当前已连接的客户端列表 */
  getClients(): readonly ConnectedClient[] {
    return this.#clients
  }
}

/** 全局单例 */
export const eventBus = new EventBus()
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd zCli && npx vitest run tests/unit/core/event-bus.test.ts`
Expected: 5 passed

- [ ] **Step 5: 提交**

```bash
git add zCli/src/core/event-bus.ts zCli/tests/unit/core/event-bus.test.ts
git commit -m "feat(core): 新增 EventBus 进程内事件总线 — CLI/Web 双向广播中枢"
```

---

### Task 2: useChat 接入 EventBus

**Files:**
- Modify: `zCli/src/core/event-bus.ts` (添加 isSerializable 工具函数)
- Modify: `zCli/src/ui/useChat.ts` (事件消费时广播到 EventBus)

- [ ] **Step 1: 在 event-bus.ts 添加序列化过滤工具**

AgentEvent 中 `permission_request` 和 `user_question_request` 含 `resolve` 回调函数，无法序列化发给 WebSocket。需要一个过滤函数。

```typescript
// 追加到 src/core/event-bus.ts 末尾

/** 将 AgentEvent 转为可 JSON 序列化的格式（去除回调函数） */
export function toSerializableEvent(event: AgentEvent): Record<string, unknown> | null {
  if (event.type === 'permission_request') {
    return { type: 'permission_request', toolName: event.toolName, args: event.args }
  }
  if (event.type === 'user_question_request') {
    return { type: 'user_question_request', questions: event.questions }
  }
  // 其他事件天然可序列化
  return event as Record<string, unknown>
}
```

- [ ] **Step 2: 修改 useChat.ts — 在事件消费循环中广播**

在 `src/ui/useChat.ts` 的 submit 方法中，事件消费循环的开头加一行：

找到 `for await (const event of loop.run(history))` 循环体内部，`sessionLogger.consume(event)` 和 `tokenMeter.consume(event)` 之后，添加：

```typescript
import { eventBus } from '@core/event-bus.js'

// 在事件消费循环体内，sessionLogger/tokenMeter 之后：
eventBus.emit(event)
```

同时在 submit 开始时广播用户输入：

```typescript
// submit 函数开头，setMessages 之后：
eventBus.emit({ type: 'user_input', text, source: 'cli' })
```

- [ ] **Step 3: 运行全量测试确认无回归**

Run: `cd zCli && npx vitest run`
Expected: 全部通过（EventBus 是纯新增，useChat 改动是追加广播）

- [ ] **Step 4: 提交**

```bash
git add zCli/src/core/event-bus.ts zCli/src/ui/useChat.ts
git commit -m "feat(core): useChat 事件消费接入 EventBus 广播"
```

---

## Chunk 2: Bridge Server (Hono + WebSocket)

### Task 3: 安装 Hono 依赖 + WebSocket 支持

**Files:**
- Modify: `zCli/package.json`

- [ ] **Step 1: 安装依赖**

```bash
cd zCli && pnpm add @hono/node-server @hono/node-ws
```

注意：`hono` 已在 dependencies 中（package.json 确认过），只需加 Node 适配器和 WebSocket 适配器。

- [ ] **Step 2: 确认安装成功**

Run: `cd zCli && node -e "require('@hono/node-server'); require('@hono/node-ws'); console.log('OK')"`
Expected: OK

- [ ] **Step 3: 提交**

```bash
git add zCli/package.json zCli/pnpm-lock.yaml
git commit -m "chore: 添加 @hono/node-server @hono/node-ws 依赖"
```

---

### Task 4: Bridge Server 实现

**Files:**
- Create: `zCli/src/web/server.ts`
- Create: `zCli/src/web/index.ts`

- [ ] **Step 1: 实现 Bridge Server**

```typescript
// src/web/server.ts

/**
 * Bridge Server — Hono HTTP + WebSocket 服务。
 *
 * 职责：
 * - WebSocket 端点：EventBus ↔ 浏览器双向桥接
 * - 静态资源托管：React SPA 构建产物（生产模式）
 * - REST API：预留 Dashboard 数据查询
 */

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import type { ServerType } from '@hono/node-server'
import { eventBus, toSerializableEvent } from '@core/event-bus.js'
import type { BusEvent } from '@core/event-bus.js'

const DEFAULT_PORT = 9800

interface BridgeServerOptions {
  port?: number
}

/** WebSocket 客户端上下文 */
interface WsClient {
  id: string
  send: (data: string) => void
}

let server: ServerType | null = null
const wsClients = new Map<string, WsClient>()
let clientCounter = 0

export function startBridgeServer(options: BridgeServerOptions = {}): { port: number; close: () => void } {
  const port = options.port ?? DEFAULT_PORT
  const app = new Hono()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

  // WebSocket 端点
  app.get('/ws', upgradeWebSocket((c) => {
    const clientId = `web-${++clientCounter}`
    return {
      onOpen(_event, ws) {
        const client: WsClient = {
          id: clientId,
          send: (data: string) => ws.send(data),
        }
        wsClients.set(clientId, client)
        eventBus.emit({ type: 'client_connect', clientId, clientType: 'web' })
      },

      onMessage(event) {
        try {
          const msg = JSON.parse(String(event.data)) as { type: string; [key: string]: unknown }
          handleClientMessage(clientId, msg)
        } catch {
          // 无效 JSON，忽略
        }
      },

      onClose() {
        wsClients.delete(clientId)
        eventBus.emit({ type: 'client_disconnect', clientId })
      },
    }
  }))

  // 健康检查
  app.get('/api/health', (c) => c.json({ status: 'ok', clients: wsClients.size }))

  // 订阅 EventBus，推送事件给所有 WebSocket 客户端
  eventBus.on((event) => {
    if (wsClients.size === 0) return
    // 只推送可序列化的事件
    const serializable = isAgentOrBridgeEvent(event) ? toSerializableEvent(event as never) ?? event : event
    const json = JSON.stringify(serializable)
    for (const client of wsClients.values()) {
      try {
        client.send(json)
      } catch {
        // 发送失败，客户端可能已断开
      }
    }
  })

  server = serve({ fetch: app.fetch, port }, () => {
    // 启动成功
  })
  injectWebSocket(server)

  return {
    port,
    close: () => {
      if (server) {
        server.close()
        server = null
      }
    },
  }
}

/** 判断是否为 AgentEvent（含 type 字段且不是 BridgeEvent） */
function isAgentOrBridgeEvent(event: BusEvent): boolean {
  return event.type !== 'client_connect' && event.type !== 'client_disconnect'
}

/** 处理来自 Web 客户端的消息 */
function handleClientMessage(clientId: string, msg: { type: string; [key: string]: unknown }): void {
  switch (msg.type) {
    case 'chat':
      eventBus.emit({
        type: 'user_input',
        text: String(msg.text ?? ''),
        source: 'web',
      })
      break
    case 'permission':
      eventBus.emit({
        type: 'permission_response',
        allow: Boolean(msg.allow),
        source: 'web',
      })
      break
    case 'abort':
      // Web 端请求中止，通过 EventBus 传递
      eventBus.emit({ type: 'user_input', text: '__abort__', source: 'web' })
      break
  }
}
```

```typescript
// src/web/index.ts
export { startBridgeServer } from './server.js'
```

- [ ] **Step 2: 添加 tsconfig paths 别名**

在 `zCli/tsconfig.json` 的 `paths` 中添加：

```json
"@web/*": ["src/web/*"]
```

- [ ] **Step 3: 运行 TypeScript 检查**

Run: `cd zCli && npx tsc --noEmit`
Expected: 零新增错误

- [ ] **Step 4: 提交**

```bash
git add zCli/src/web/server.ts zCli/src/web/index.ts zCli/tsconfig.json
git commit -m "feat(web): Bridge Server — Hono HTTP + WebSocket + EventBus 桥接"
```

---

### Task 5: CLI 入口集成 --web 标志

**Files:**
- Modify: `zCli/bin/zcli.ts`
- Modify: `zCli/package.json`

- [ ] **Step 1: 修改 parseArgs 支持 --web**

在 `bin/zcli.ts` 的 `CliArgs` 接口添加 `web: boolean`，parseArgs 解析 `--web` 标志。

- [ ] **Step 2: 交互模式分支添加 Bridge Server 启动**

在 `bin/zcli.ts` 交互模式的 `else` 分支中，Promise.all 的模块加载后，判断 `args.web` 则启动 Bridge Server：

```typescript
if (args.web) {
  const { startBridgeServer } = await import('../src/web/index.js')
  const bridge = startBridgeServer()
  process.stderr.write(`Web UI: http://localhost:${bridge.port}\n`)
}
```

- [ ] **Step 3: 添加 dev:web script**

在 `package.json` 的 `scripts` 中添加：

```json
"dev:web": "tsx bin/zcli.ts --web"
```

- [ ] **Step 4: 手动验证**

Run: `cd zCli && pnpm dev:web`
Expected: 终端正常启动 CLI + 输出 `Web UI: http://localhost:9800`
验证: `curl http://localhost:9800/api/health` 返回 `{"status":"ok","clients":0}`

- [ ] **Step 5: 提交**

```bash
git add zCli/bin/zcli.ts zCli/package.json
git commit -m "feat(cli): --web 标志启动 Bridge Server，新增 dev:web script"
```

---

## Chunk 3: React SPA (dashboard-ui/)

### Task 6: 初始化 dashboard-ui 项目

**Files:**
- Create: `zCli/dashboard-ui/package.json`
- Create: `zCli/dashboard-ui/tsconfig.json`
- Create: `zCli/dashboard-ui/vite.config.ts`
- Create: `zCli/dashboard-ui/index.html`
- Create: `zCli/dashboard-ui/src/main.tsx`
- Create: `zCli/dashboard-ui/tailwind.config.js`
- Create: `zCli/dashboard-ui/postcss.config.js`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "zcli-dashboard-ui",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-markdown": "^9.0.0",
    "rehype-highlight": "^7.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "tailwindcss": "^3.4.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0"
  }
}
```

- [ ] **Step 2: 创建 vite.config.ts**

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:9800', ws: true },
      '/api': { target: 'http://localhost:9800' },
    },
  },
  build: {
    outDir: 'dist',
  },
})
```

- [ ] **Step 3: 创建 tailwind + postcss 配置**

```javascript
// tailwind.config.js
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
}
```

```javascript
// postcss.config.js
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
}
```

- [ ] **Step 4: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 5: 创建 index.html + main.tsx 入口**

```html
<!-- index.html -->
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ZCli Dashboard</title>
  </head>
  <body class="bg-gray-950 text-gray-100">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

```typescript
// src/main.tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App.js'
import './styles/globals.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
```

```css
/* src/styles/globals.css */
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 6: 安装依赖**

Run: `cd zCli/dashboard-ui && pnpm install`

- [ ] **Step 7: 验证 Vite 启动**

Run: `cd zCli/dashboard-ui && pnpm dev`
Expected: Vite 启动在 5173 端口，浏览器可访问

- [ ] **Step 8: 提交**

```bash
git add zCli/dashboard-ui/
git commit -m "feat(dashboard-ui): 初始化 React + Vite + Tailwind 前端项目"
```

---

### Task 7: useWebSocket Hook

**Files:**
- Create: `zCli/dashboard-ui/src/hooks/useWebSocket.ts`
- Create: `zCli/dashboard-ui/src/types.ts`

- [ ] **Step 1: 定义共享类型**

```typescript
// src/types.ts

/** 服务端推送的事件 */
export type ServerEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; toolName: string; toolCallId: string; args: Record<string, unknown> }
  | { type: 'tool_done'; toolName: string; toolCallId: string; durationMs: number; success: boolean; resultSummary?: string }
  | { type: 'permission_request'; toolName: string; args: Record<string, unknown> }
  | { type: 'error'; error: string }
  | { type: 'done' }
  | { type: 'user_input'; text: string; source: 'cli' | 'web' }
  | { type: 'llm_start'; provider: string; model: string }
  | { type: 'llm_usage'; inputTokens: number; outputTokens: number }

/** 客户端发送的消息 */
export type ClientMessage =
  | { type: 'chat'; text: string }
  | { type: 'permission'; allow: boolean }
  | { type: 'abort' }

/** 聊天消息（UI 渲染用） */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  source?: 'cli' | 'web'
}

/** 工具执行状态 */
export interface ToolEvent {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  status: 'running' | 'done'
  durationMs?: number
  success?: boolean
  resultSummary?: string
}
```

- [ ] **Step 2: 实现 useWebSocket**

```typescript
// src/hooks/useWebSocket.ts

import { useState, useEffect, useRef, useCallback } from 'react'
import type { ServerEvent, ClientMessage } from '../types.js'

interface UseWebSocketReturn {
  connected: boolean
  lastEvent: ServerEvent | null
  send: (msg: ClientMessage) => void
}

const WS_URL = `ws://${window.location.hostname}:${window.location.port}/ws`
const RECONNECT_INTERVAL_MS = 2000

export function useWebSocket(): UseWebSocketReturn {
  const [connected, setConnected] = useState(false)
  const [lastEvent, setLastEvent] = useState<ServerEvent | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>()

  const connect = useCallback(() => {
    const ws = new WebSocket(WS_URL)

    ws.onopen = () => {
      setConnected(true)
    }

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as ServerEvent
        setLastEvent(event)
      } catch {
        // 无效 JSON
      }
    }

    ws.onclose = () => {
      setConnected(false)
      wsRef.current = null
      // 自动重连
      reconnectTimer.current = setTimeout(connect, RECONNECT_INTERVAL_MS)
    }

    ws.onerror = () => {
      ws.close()
    }

    wsRef.current = ws
  }, [])

  useEffect(() => {
    connect()
    return () => {
      clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  return { connected, lastEvent, send }
}
```

- [ ] **Step 3: 提交**

```bash
git add zCli/dashboard-ui/src/types.ts zCli/dashboard-ui/src/hooks/useWebSocket.ts
git commit -m "feat(dashboard-ui): useWebSocket hook — 自动重连 + 事件解析"
```

---

### Task 8: ChatPage 聊天页面

**Files:**
- Create: `zCli/dashboard-ui/src/App.tsx`
- Create: `zCli/dashboard-ui/src/pages/ChatPage.tsx`
- Create: `zCli/dashboard-ui/src/components/MessageBubble.tsx`
- Create: `zCli/dashboard-ui/src/components/InputBar.tsx`
- Create: `zCli/dashboard-ui/src/components/ToolStatus.tsx`
- Create: `zCli/dashboard-ui/src/components/PermissionCard.tsx`

- [ ] **Step 1: 创建 App.tsx**

```tsx
// src/App.tsx
import { ChatPage } from './pages/ChatPage.js'

export function App() {
  return <ChatPage />
}
```

- [ ] **Step 2: 创建 MessageBubble 组件**

```tsx
// src/components/MessageBubble.tsx
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import type { ChatMessage } from '../types.js'

interface Props {
  message: ChatMessage
}

export function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user'
  const sourceTag = message.source === 'web' ? ' (web)' : message.source === 'cli' ? ' (cli)' : ''

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      <div className={`max-w-[80%] rounded-lg px-4 py-3 ${
        isUser
          ? 'bg-blue-600 text-white'
          : 'bg-gray-800 text-gray-100'
      }`}>
        {sourceTag && (
          <span className="text-xs opacity-50 mb-1 block">{sourceTag}</span>
        )}
        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="prose prose-invert prose-sm max-w-none">
            <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
              {message.content}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: 创建 InputBar 组件**

```tsx
// src/components/InputBar.tsx
import { useState, useCallback } from 'react'
import type { KeyboardEvent } from 'react'

interface Props {
  onSubmit: (text: string) => void
  disabled?: boolean
}

export function InputBar({ onSubmit, disabled }: Props) {
  const [text, setText] = useState('')

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    onSubmit(trimmed)
    setText('')
  }, [text, disabled, onSubmit])

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }, [handleSubmit])

  return (
    <div className="flex gap-2 p-4 border-t border-gray-700">
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
        disabled={disabled}
        className="flex-1 bg-gray-800 text-gray-100 rounded-lg px-4 py-3 resize-none outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500 disabled:opacity-50"
        rows={2}
      />
      <button
        onClick={handleSubmit}
        disabled={disabled || !text.trim()}
        className="self-end px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-50 disabled:hover:bg-blue-600 transition-colors"
      >
        发送
      </button>
    </div>
  )
}
```

- [ ] **Step 4: 创建 ToolStatus 组件**

```tsx
// src/components/ToolStatus.tsx
import type { ToolEvent } from '../types.js'

interface Props {
  events: ToolEvent[]
}

export function ToolStatus({ events }: Props) {
  if (events.length === 0) return null
  return (
    <div className="px-4 py-2 space-y-1">
      {events.map(e => (
        <div key={e.toolCallId} className="flex items-center gap-2 text-sm text-gray-400">
          <span className={e.status === 'running' ? 'animate-pulse text-yellow-400' : e.success ? 'text-green-400' : 'text-red-400'}>
            {e.status === 'running' ? '⟳' : e.success ? '✓' : '✗'}
          </span>
          <span className="font-mono">{e.toolName}</span>
          {e.durationMs != null && <span className="text-gray-500">({e.durationMs}ms)</span>}
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 5: 创建 PermissionCard 组件**

```tsx
// src/components/PermissionCard.tsx

interface Props {
  toolName: string
  args: Record<string, unknown>
  onAllow: () => void
  onDeny: () => void
}

export function PermissionCard({ toolName, args, onAllow, onDeny }: Props) {
  return (
    <div className="mx-4 my-2 p-4 bg-yellow-900/30 border border-yellow-600/50 rounded-lg">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-yellow-400 text-lg">⚠</span>
        <span className="font-medium text-yellow-200">权限确认</span>
      </div>
      <p className="text-sm text-gray-300 mb-1">
        工具 <span className="font-mono text-yellow-300">{toolName}</span> 请求执行：
      </p>
      <pre className="text-xs bg-gray-900 rounded p-2 mb-3 overflow-x-auto text-gray-400">
        {JSON.stringify(args, null, 2)}
      </pre>
      <div className="flex gap-2">
        <button onClick={onAllow} className="px-4 py-1.5 bg-green-600 text-white rounded hover:bg-green-500 text-sm">
          允许
        </button>
        <button onClick={onDeny} className="px-4 py-1.5 bg-red-600 text-white rounded hover:bg-red-500 text-sm">
          拒绝
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: 创建 ChatPage — 组装所有组件**

```tsx
// src/pages/ChatPage.tsx
import { useState, useEffect, useRef, useCallback } from 'react'
import { useWebSocket } from '../hooks/useWebSocket.js'
import { MessageBubble } from '../components/MessageBubble.js'
import { InputBar } from '../components/InputBar.js'
import { ToolStatus } from '../components/ToolStatus.js'
import { PermissionCard } from '../components/PermissionCard.js'
import type { ChatMessage, ToolEvent, ServerEvent } from '../types.js'

export function ChatPage() {
  const { connected, lastEvent, send } = useWebSocket()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([])
  const [pendingPermission, setPendingPermission] = useState<{ toolName: string; args: Record<string, unknown> } | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const msgIdCounter = useRef(0)

  // 处理服务端事件
  useEffect(() => {
    if (!lastEvent) return
    handleServerEvent(lastEvent)
  }, [lastEvent])

  // 自动滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streaming])

  function handleServerEvent(event: ServerEvent) {
    switch (event.type) {
      case 'user_input': {
        const msg: ChatMessage = {
          id: `msg-${++msgIdCounter.current}`,
          role: 'user',
          content: event.text,
          source: event.source,
        }
        setMessages(prev => [...prev, msg])
        setStreaming('')
        setIsStreaming(true)
        break
      }
      case 'text':
        setStreaming(prev => prev + event.text)
        break
      case 'tool_start':
        setToolEvents(prev => [...prev, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          status: 'running',
        }])
        break
      case 'tool_done':
        setToolEvents(prev => prev.map(e =>
          e.toolCallId === event.toolCallId
            ? { ...e, status: 'done' as const, durationMs: event.durationMs, success: event.success, resultSummary: event.resultSummary }
            : e
        ))
        break
      case 'permission_request':
        setPendingPermission({ toolName: event.toolName, args: event.args })
        break
      case 'done': {
        if (streaming) {
          const assistantMsg: ChatMessage = {
            id: `msg-${++msgIdCounter.current}`,
            role: 'assistant',
            content: streaming,
          }
          setMessages(prev => [...prev, assistantMsg])
        }
        setStreaming('')
        setIsStreaming(false)
        setToolEvents([])
        setPendingPermission(null)
        break
      }
      case 'error':
        setStreaming('')
        setIsStreaming(false)
        setMessages(prev => [...prev, {
          id: `msg-${++msgIdCounter.current}`,
          role: 'system',
          content: `错误: ${event.error}`,
        }])
        break
    }
  }

  const handleSubmit = useCallback((text: string) => {
    send({ type: 'chat', text })
  }, [send])

  const handlePermission = useCallback((allow: boolean) => {
    send({ type: 'permission', allow })
    setPendingPermission(null)
  }, [send])

  return (
    <div className="flex flex-col h-screen">
      {/* 标题栏 */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <h1 className="text-lg font-semibold">ZCli Dashboard</h1>
        <span className={`text-xs px-2 py-1 rounded ${connected ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'}`}>
          {connected ? '已连接' : '断开'}
        </span>
      </header>

      {/* 消息区域 */}
      <div className="flex-1 overflow-y-auto p-4">
        {messages.map(msg => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* 流式输出 */}
        {streaming && (
          <MessageBubble message={{ id: 'streaming', role: 'assistant', content: streaming }} />
        )}

        {/* 工具状态 */}
        <ToolStatus events={toolEvents} />

        {/* 权限弹窗 */}
        {pendingPermission && (
          <PermissionCard
            toolName={pendingPermission.toolName}
            args={pendingPermission.args}
            onAllow={() => handlePermission(true)}
            onDeny={() => handlePermission(false)}
          />
        )}

        <div ref={bottomRef} />
      </div>

      {/* 输入栏 */}
      <InputBar onSubmit={handleSubmit} disabled={!connected} />
    </div>
  )
}
```

- [ ] **Step 7: 验证前端页面渲染**

Run: `cd zCli/dashboard-ui && pnpm dev`
Expected: 浏览器 http://localhost:5173 显示 ZCli Dashboard 标题 + 输入框 + "断开"状态

- [ ] **Step 8: 提交**

```bash
git add zCli/dashboard-ui/src/
git commit -m "feat(dashboard-ui): ChatPage 聊天页面 — 消息气泡 + 输入框 + 工具状态 + 权限卡片"
```

---

## Chunk 4: 双向融合 + useChat 回流

### Task 9: Web 端输入回流到 useChat

**Files:**
- Modify: `zCli/src/ui/useChat.ts`

- [ ] **Step 1: useChat 监听 EventBus 的 user_input 事件**

在 useChat hook 内部添加 EventBus 订阅，当收到 `source: 'web'` 的 `user_input` 时调用 submit：

```typescript
// 在 useChat hook 内部（其他 useEffect 旁边）
useEffect(() => {
  const off = eventBus.onType('user_input', (event) => {
    if (event.source === 'web') {
      // Web 端发来的消息，调用 submit 驱动 AgentLoop
      submit(event.text)
    }
  })
  return off
}, [submit])
```

同时监听 Web 端的权限响应：

```typescript
useEffect(() => {
  const off = eventBus.onType('permission_response', (event) => {
    if (event.source === 'web' && pendingPermission) {
      resolvePermission(event.allow)
    }
  })
  return off
}, [pendingPermission, resolvePermission])
```

以及 Web 端的 abort 请求：

```typescript
useEffect(() => {
  const off = eventBus.onType('user_input', (event) => {
    if (event.source === 'web' && event.text === '__abort__') {
      abort()
    }
  })
  return off
}, [abort])
```

- [ ] **Step 2: 运行全量测试确认无回归**

Run: `cd zCli && npx vitest run`
Expected: 全部通过

- [ ] **Step 3: 提交**

```bash
git add zCli/src/ui/useChat.ts
git commit -m "feat(useChat): 监听 EventBus Web 端输入/权限/中止 — 双向对话融合"
```

---

### Task 10: 端到端手动验证

- [ ] **Step 1: 同时启动 CLI + Web**

终端 1: `cd zCli && pnpm dev:web`
终端 2 (或同一终端): 浏览器打开 `http://localhost:5173`

- [ ] **Step 2: CLI → Web 方向验证**

在 CLI 终端输入一条消息，观察 Web 页面是否实时显示该消息和 LLM 回复的流式输出。

- [ ] **Step 3: Web → CLI 方向验证**

在 Web 页面输入框输入一条消息并发送，观察 CLI 终端是否显示该消息和 LLM 回复。

- [ ] **Step 4: 权限弹窗双端同步验证**

触发一个需要权限确认的工具（如 bash），观察 CLI 和 Web 两端是否都显示权限请求，在任一端点击允许后另一端自动收起。

- [ ] **Step 5: 验证通过后提交 dev:web script**

```bash
cd zCli && pnpm dev:web  # 确认启动流程正常
# Ctrl+C 退出
git add -A
git commit -m "feat: Bridge Server + Dashboard UI — CLI/Web 双向实时对话同步 (Phase 1 完成)"
```

---

## 附录：文件清单总览

### 新增文件 (12 个)

| 文件 | 职责 |
|------|------|
| `src/core/event-bus.ts` | 进程内事件总线 |
| `src/web/server.ts` | Hono HTTP + WebSocket Bridge Server |
| `src/web/index.ts` | 导出 barrel |
| `tests/unit/core/event-bus.test.ts` | EventBus 单元测试 |
| `dashboard-ui/package.json` | 前端项目配置 |
| `dashboard-ui/tsconfig.json` | 前端 TS 配置 |
| `dashboard-ui/vite.config.ts` | Vite 构建配置 + WebSocket 代理 |
| `dashboard-ui/index.html` | SPA 入口 HTML |
| `dashboard-ui/src/main.tsx` | React 入口 |
| `dashboard-ui/src/App.tsx` | 路由 + 布局 |
| `dashboard-ui/src/hooks/useWebSocket.ts` | WebSocket 连接管理 |
| `dashboard-ui/src/pages/ChatPage.tsx` | 聊天页面 |
| `dashboard-ui/src/components/MessageBubble.tsx` | 消息气泡 |
| `dashboard-ui/src/components/InputBar.tsx` | 输入框 |
| `dashboard-ui/src/components/ToolStatus.tsx` | 工具状态 |
| `dashboard-ui/src/components/PermissionCard.tsx` | 权限确认卡片 |
| `dashboard-ui/src/types.ts` | 共享类型定义 |
| `dashboard-ui/src/styles/globals.css` | Tailwind 入口 |
| `dashboard-ui/tailwind.config.js` | Tailwind 配置 |
| `dashboard-ui/postcss.config.js` | PostCSS 配置 |

### 修改文件 (4 个)

| 文件 | 改动 |
|------|------|
| `bin/zcli.ts` | 新增 `--web` 参数 + Bridge Server 启动 |
| `src/ui/useChat.ts` | 事件广播 + Web 端输入回流监听 |
| `package.json` | 新增 `dev:web` script |
| `tsconfig.json` | 新增 `@web/*` 路径别名 |
