# Bridge Server 架构调研与 Web 能力规划

> 日期: 2026-03-14
> 状态: 调研完成，待确认核心方案
> 关联: F11 WebUI 看板（需求文档）

## 一、用户目标

不是简单的"CLI 旁边开个 Web 页面"，而是：

1. CLI 里对话 → Web 界面实时同步显示
2. Web 界面对话 → CLI 里实时同步显示
3. 两端共享同一个 AgentLoop 实例、同一个会话上下文
4. 后期可扩展：Dashboard 看板、对话回放、设置管理等高级 Web 能力

**核心需求：双向实时同步，两端是同一个对话的两个视图。**

## 二、业界方案调研

### 2.1 Claude Code — Companion 模式

Claude Code 通过一个隐藏的 `--sdk-url` 标志，将终端输出重定向到 WebSocket 服务器（NDJSON 格式）。Companion 工具作为 WebSocket Server 接收数据，管道推送到浏览器页面。

```
Claude Code CLI ──(WebSocket/NDJSON)──→ Companion Server ──→ Browser
```

**特点**：单向为主（CLI → Web 显示），Web 端输入能力有限。社区开源的 `claude-code-web` 通过 `node-pty` + `xterm.js` 实现了更完整的双向交互。

### 2.2 claude-code-web（社区方案）

```
Browser (xterm.js) ←──WebSocket──→ Express Server (claude-bridge.js) ←──node-pty──→ Claude CLI Process
```

- `claude-bridge.js` 负责 spawn 和管理 Claude Code 进程
- WebSocket 实现浏览器到 CLI 的双向通信
- xterm.js 做终端模拟，完整还原 ANSI 渲染
- 支持多会话、认证、会话持久化

**局限**：本质是"远程终端"，Web 端只是终端的镜像，无法做独立的 Web UI。

### 2.3 claude-code-server（WebSocket 方案）

```
Browser ←──WebSocket──→ WebSocket Server ←──spawn──→ Claude CLI
```

用 WebSocket 把 CLI 的 stdout/stderr 推到浏览器。更轻量，但也是终端镜像模式。

### 2.4 Claude Remote（tmux 方案）

用 tmux 做会话持久化：
- capture loop 按间隔捕获 pane 内容
- diff 增量发送给连接的客户端
- ring buffer 支持重连恢复

**适合远程场景，但不适合我们的双向对话融合需求。**

## 三、ZCli Bridge Server 架构设计

### 3.1 核心理念

不做"终端镜像"，而是在 **AgentLoop 层面** 做桥接。CLI 和 Web 都是 AgentLoop 的 **消费者**，共享同一个事件流。

```
                        ┌──────────────────────┐
                        │    Bridge Server      │
                        │   (EventBus + API)    │
                        │                       │
                        │  ┌─────────────────┐  │
   CLI (Ink) ───────────┤  │   AgentLoop     │  ├─────── Web (React SPA)
   - 渲染终端 UI         │  │   (核心引擎)    │  │        - 渲染 Web UI
   - 键盘输入            │  │                 │  │        - 表单输入
   - 工具权限弹窗        │  └────────┬────────┘  │        - 权限确认
                        │           │            │
                        │  ┌────────▼────────┐  │
                        │  │   EventBus      │  │
                        │  │  (双向广播)      │  │
                        │  └─────────────────┘  │
                        └──────────────────────┘
```

### 3.2 分层架构

```
Layer 0: AgentLoop（已有）
  │  纯逻辑引擎，AsyncGenerator<AgentEvent>
  │  不绑定任何 UI
  │
Layer 1: EventBus（新增）
  │  进程内事件总线，双向广播
  │  AgentEvent → 广播到所有订阅者
  │  UserInput → 路由到 AgentLoop
  │
Layer 2: Bridge Server（新增）
  │  HTTP Server (Hono) + WebSocket
  │  - WebSocket: 实时事件推送 + 接收 Web 端输入
  │  - REST API: Dashboard 数据查询
  │  - 静态资源: React SPA 构建产物
  │
Layer 3-A: CLI Consumer（已有，改造）
  │  useChat hook 改为订阅 EventBus
  │  Ink 渲染不变
  │
Layer 3-B: Web Consumer（新增）
  │  React SPA (Vite 构建)
  │  WebSocket 连接 Bridge
  │  独立的聊天 UI + Dashboard
```

### 3.3 EventBus 核心接口

```typescript
// src/core/event-bus.ts

type BusEvent =
  | AgentEvent                                    // AgentLoop 产出的事件
  | { type: 'user_input'; text: string; source: 'cli' | 'web' }
  | { type: 'permission_response'; allow: boolean; source: 'cli' | 'web' }
  | { type: 'client_connect'; clientId: string; clientType: 'cli' | 'web' }
  | { type: 'client_disconnect'; clientId: string }

interface EventBus {
  /** 发布事件（广播给所有订阅者） */
  emit(event: BusEvent): void
  /** 订阅事件 */
  on(handler: (event: BusEvent) => void): () => void
  /** 订阅特定类型 */
  on<T extends BusEvent['type']>(type: T, handler: (event: Extract<BusEvent, { type: T }>) => void): () => void
}
```

### 3.4 WebSocket 协议

```
Client → Server (JSON):
  { "type": "chat",       "text": "帮我写一个函数" }
  { "type": "permission", "allow": true }
  { "type": "abort" }
  { "type": "command",    "text": "/model glm-5" }

Server → Client (JSON):
  { "type": "text",       "text": "好的，" }
  { "type": "tool_start", "toolName": "edit_file", "args": {...} }
  { "type": "tool_done",  "toolName": "edit_file", "success": true, "resultSummary": "..." }
  { "type": "permission_request", "toolName": "bash", "args": {...} }
  { "type": "done" }
  { "type": "history",    "messages": [...] }   // 连接时推送完整历史
```

### 3.5 启动流程

```
pnpm dev:web
  │
  ├── 启动 Vite Dev Server (port 5173, HMR 热更新)
  ├── 启动 Bridge Server (Hono + WebSocket, port 9800)
  ├── 启动 CLI (Ink, 终端交互)
  ├── CLI 和 Web 都连接到同一个 EventBus
  │
  └── 终端输出: "ZCli v0.1.0 — Web UI: http://localhost:5173"

pnpm build && pnpm start  (生产模式)
  │
  ├── Vite 构建 React SPA → dist/ 静态资源
  ├── Hono 托管 dist/ + WebSocket
  ├── 启动 CLI
  │
  └── 终端输出: "ZCli v0.1.0 — Web UI: http://localhost:9800"
```

## 四、实施路线

### Phase 1：基础设施 + 双向对话（核心）

**目标**：CLI 和 Web 双向对话融合，一端说话两端同步

```
预估工作量: 2 天

新增文件:
  zCli/
  ├── src/core/event-bus.ts           — 进程内事件总线 (~80行)
  ├── src/web/
  │   ├── server.ts                   — Hono HTTP + WebSocket 服务 (~150行)
  │   ├── routes/
  │   │   ├── ws.ts                   — WebSocket 端点，EventBus ↔ 浏览器桥接
  │   │   └── api.ts                  — REST API (预留 Dashboard 查询)
  │   └── index.ts                    — 导出 startBridgeServer()
  ├── dashboard-ui/                    — React SPA (独立 Vite 项目，与 src/ 平级)
  │   ├── package.json
  │   ├── vite.config.ts
  │   ├── index.html
  │   ├── src/
  │   │   ├── main.tsx                — React 入口
  │   │   ├── App.tsx                 — 路由 + 布局
  │   │   ├── hooks/
  │   │   │   └── useWebSocket.ts     — WebSocket 连接 + 重连 + 消息解析
  │   │   ├── pages/
  │   │   │   └── ChatPage.tsx        — 聊天页面（对话 + 输入 + 工具状态）
  │   │   ├── components/
  │   │   │   ├── MessageBubble.tsx   — 消息气泡（Markdown 渲染 + 代码高亮）
  │   │   │   ├── InputBar.tsx        — 输入框 + 发送按钮
  │   │   │   ├── ToolStatus.tsx      — 工具执行状态卡片
  │   │   │   └── PermissionCard.tsx  — 权限确认卡片
  │   │   └── styles/
  │   │       └── globals.css
  │   └── tsconfig.json

改动文件:
  - bin/zcli.ts                       — 新增 --web 标志，启动 Bridge Server
  - src/ui/useChat.ts                 — 事件消费时同步发给 EventBus
  - package.json                      — 新增 dev:web / build:web scripts
```

改动要点：
1. `EventBus` — 进程内发布-订阅，支持类型过滤
2. `useChat` 微改 — AgentEvent 消费时 `eventBus.emit()` 广播
3. Bridge Server — Hono 起 HTTP + WebSocket，桥接 EventBus ↔ 浏览器
4. Web 端输入 → WebSocket → EventBus → `useChat.submit()` → AgentLoop
5. React SPA — ChatPage 聊天页面，Vite 开发服务器 HMR 热更新
6. 权限弹窗双端同步（先到先得）

### Phase 2：Dashboard 看板

**目标**：对接需求文档 F11 的四大页面

```
预估工作量: 2-3 天

新增页面:
  dashboard-ui/src/pages/
  ├── OverviewPage.tsx        — 总览大盘（token 趋势、模型分布、费用排行）
  ├── ConversationsPage.tsx   — 对话详情（历史会话、对话回放）
  ├── LogsPage.tsx            — 日志浏览（实时日志流、按类型筛选）
  └── SettingsPage.tsx        — 设置管理（模型配置、计价规则 CRUD）

新增 API:
  src/web/routes/api.ts
  ├── GET  /api/overview      — 今日/本周/本月 token 统计
  ├── GET  /api/conversations — 历史会话列表
  ├── GET  /api/conversations/:id — 单个会话详情
  ├── GET  /api/logs          — 日志查询（分页 + 筛选）
  ├── GET  /api/settings      — 读取配置
  ├── PUT  /api/settings      — 更新配置
  ├── GET  /api/pricing       — 计价规则列表
  ├── POST /api/pricing       — 新增计价规则
  ├── PUT  /api/pricing/:id   — 更新计价规则
  └── DELETE /api/pricing/:id — 删除计价规则
```

### Phase 3：高级能力

```
预估工作量: 按需迭代

可选方向:
  - 对话分支可视化（fork 树状图）
  - 代码 Diff 视图（Monaco Editor 集成）
  - MCP Server 管理界面
  - 多会话标签页
  - 移动端响应式适配
```

## 五、技术选型

| 组件 | 选择 | 理由 |
|------|------|------|
| HTTP Server | **Hono** | 需求文档已确定，轻量 (14KB)，Bun 原生支持 |
| 实时通信 | **WebSocket** | 双向通信必须，SSE 只能单向 |
| 前端框架 | **React 18 + TypeScript** | 需求文档规划，复用 React 生态，CLI 端已在用 React/Ink |
| 前端构建 | **Vite** | 快速 HMR，React 生态首选，生产构建高效 |
| Markdown 渲染 | **react-markdown + rehype-highlight** | 消息气泡需要渲染 Markdown + 代码高亮 |
| 样式方案 | **Tailwind CSS** | 快速搭建 UI，不需要维护独立样式文件 |
| EventBus | **自研 (~80行)** | 进程内同步广播，不需要 Redis/MQ |

## 六、关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 桥接层级 | AgentLoop 事件层，非终端镜像 | 终端镜像（xterm.js）无法做独立 Web UI，且绑定终端渲染细节 |
| EventBus 位置 | CLI 进程内 | 单进程最简，CLI 退出则 Web 也关闭，符合 CLI 工具生命周期 |
| 前端架构 | React SPA + Vite，直接上 | 跳过纯 HTML 阶段，避免重写浪费；React 生态组件(Markdown/代码高亮)直接可用 |
| 项目结构 | `dashboard-ui/` 与 `src/` 平级，独立 `package.json` | 前后端构建解耦，Vite 和 CLI 的 tsup 互不干扰；与需求文档目录规划一致 |
| 样式方案 | Tailwind CSS 起步，后期可切原生 | 快速搭 UI，不锁死技术选型 |
| 开发体验 | dev 模式 Vite HMR，生产模式 Hono 托管构建产物 | 开发时改前端代码即时刷新，无需重启 CLI |
| 权限冲突 | 先到先得 | CLI 和 Web 同时弹出权限请求，谁先点击算谁的，另一端自动收起 |
| 对话归属 | 统一 session | 两端共享同一个 sessionId，JSONL 日志不区分来源（BusEvent 有 source 字段可溯源） |
| Web 端默认权限 | 继承 CLI 设置 | 不做独立的 Web 权限模型，复用 `.zcli/settings.local.json` |

## 七、与现有架构的关系

```
现有:
  bin/zcli.ts → useChat (React Hook) → AgentLoop → Provider

改造后:
  bin/zcli.ts
    ├── useChat (React Hook) ──→ EventBus ←── AgentLoop
    │      ↑ 订阅事件，渲染 Ink          ↑ 产出 AgentEvent
    │                                     │
    └── Bridge Server (Hono) ──→ EventBus
           ↕ WebSocket                ↑ 订阅事件
        React SPA (Browser)          Web 端输入 → submit()
```

**侵入性评估**：

| 模块 | 改动程度 | 说明 |
|------|---------|------|
| `AgentLoop` | **零改动** | 已是 AsyncGenerator，事件流天然可分发 |
| `useChat` | **微改** | 事件消费时加一行 `eventBus.emit(event)` |
| `bootstrap` | **零改动** | Bridge Server 是新增模块 |
| `bin/zcli.ts` | **小改** | 加 `--web` 判断 + `startBridgeServer()` 调用 |
| `providers` | **零改动** | 不感知 Web 的存在 |
| `tools` | **零改动** | 不感知 Web 的存在 |

**新增模块约 300 行后端代码 + React SPA 前端项目。**
