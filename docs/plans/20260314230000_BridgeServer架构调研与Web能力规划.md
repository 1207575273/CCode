> 备注：项目原名 ZCli，2026-03-20 更名为 cCli（品牌名 CCode），详见 01_需求与项目管理核心文档/20260320030000_项目改名_ZCli到CCode.md

# Bridge Server 架构调研与 Web 能力规划

> 日期: 2026-03-14
> 状态: Phase 1 已落地（2026-03-15）
> 关联: F11 WebUI 看板（需求文档）
> 实施记录: `20260315030000_BridgeServer与WebUI实施总结.md`

## 一、用户目标

不是简单的"CLI 旁边开个 Web 页面"，而是：

1. CLI 里对话 → Web 界面实时同步显示
2. Web 界面对话 → CLI 里实时同步显示
3. 多终端共享 Bridge Server，按 sessionId 隔离
4. 后期可扩展：Dashboard 看板、对话回放、设置管理等高级 Web 能力

**核心需求：双向实时同步，多 session 隔离，所有参与者地位平等。**

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

**局限**：本质是"远程终端"，Web 端只是终端的镜像，无法做独立的 Web UI。

### 2.3 Claude Remote（tmux 方案）

用 tmux 做会话持久化 + diff 增量推送。

**适合远程场景，但不适合我们的双向对话融合需求。**

### 2.4 结论

业界方案都是"终端镜像"模式，无法满足双向融合 + 多 session 隔离需求。需要自研。

## 三、ZCli Bridge Server 最终架构

### 3.1 核心理念

**Bridge Server 是纯消息路由器**，不持有 EventBus、不持有 AgentLoop。所有 CLI 和 Web 都是平等的 WebSocket 客户端，按 sessionId 隔离路由。

```
Bridge Server (port 9800) — 纯消息路由器
  │
  │  session registry: sessionId → [clients...]
  │
  ├── CLI-1 (ws client, session-111) — 推事件 / 收 Web 输入
  ├── CLI-2 (ws client, session-222) — 推事件 / 收 Web 输入
  ├── Web-A (ws client, session-111) — 收事件 / 发输入
  └── Web-B (ws client, session-222) — 收事件 / 发输入
```

### 3.2 分层架构

```
Layer 0: AgentLoop（已有，零改动）
  │  纯逻辑引擎，AsyncGenerator<AgentEvent>
  │
Layer 1: EventBus（src/core/event-bus.ts）
  │  进程内事件总线
  │  AgentEvent → 广播到本地订阅者（useChat + BridgeClient）
  │
Layer 2-A: Bridge Client（src/bridge/client.ts）
  │  CLI 端 WebSocket 客户端
  │  订阅本地 EventBus → 推送到 Bridge Server
  │  接收 Bridge 转发的 Web 输入 → 发布到本地 EventBus
  │
Layer 2-B: Bridge Server（src/bridge/server.ts）
  │  Hono HTTP + WebSocket 纯路由器
  │  按 sessionId 路由：CLI 事件 → 同 session Web，Web 输入 → 同 session CLI
  │  REST API: /api/health, /api/bridge/stop
  │  静态资源: dev 反代 Vite / 生产托管 web/dist/
  │
Layer 3: Web 前端（web/）
  │  React SPA (Vite + Tailwind)
  │  WebSocket 连接 Bridge，register 声明 web 身份 + sessionId
  │  聊天页面 + 工具状态 + 权限确认 + 问卷表单
```

### 3.3 WebSocket 协议

```
连接后第一条消息 — register（声明身份和 session）:
  { "type": "register", "clientType": "cli"|"web", "sessionId": "019cebb1-xxx" }

CLI → Bridge（推送事件，包装在 event 信封中）:
  { "type": "event", "payload": { "type": "text", "text": "..." } }
  { "type": "event", "payload": { "type": "tool_start", "toolName": "...", ... } }
  { "type": "event", "payload": { "type": "user_input", "text": "...", "source": "cli" } }

Web → Bridge（用户输入，直接发送）:
  { "type": "chat", "text": "帮我写一个函数" }
  { "type": "permission", "allow": true }
  { "type": "question", "cancelled": false, "answers": {...} }
  { "type": "abort" }

Bridge → Web（转发 CLI 事件，解包 payload 后发送）:
  { "type": "text", "text": "好的，" }
  { "type": "tool_start", "toolName": "edit_file", "args": {...} }
  { "type": "tool_done", "toolName": "edit_file", "success": true, "resultSummary": "..." }
  { "type": "permission_request", "toolName": "bash", "args": {...} }
  { "type": "user_question_request", "questions": [...] }
  { "type": "session_init", "sessionId": "...", "messages": [...] }
  { "type": "done" }

任何客户端 → Bridge:
  { "type": "bridge_stop" }
```

**路由规则**：
- CLI 推的 `event` → 解包 `payload` → 广播给**同 sessionId 的 Web 客户端**
- Web 发的 `chat/permission/question/abort` → 转发给**同 sessionId 的 CLI 客户端**
- Web 注册空 sessionId 时 → 自动分配第一个活跃 CLI session

### 3.4 启动流程

```
pnpm dev:web
  │
  ├─ 检测 9800 端口
  │   ├─ 空闲 → 启动 Bridge Server (Hono) + Vite dev server (后台子进程)
  │   └─ 已占用 → 跳过（复用已有 Bridge）
  │
  ├─ render() Ink UI → useChat mount → ensureSession() 创建 session
  │
  ├─ connectBridge(9800, sessionId) — 作为 WS 客户端连接 Bridge
  │
  └─ 终端显示：
       bootstrap 1089ms (skills 220 → hooks 9 → startHooks 85 | fileIndex 1065 | instructions 47ms)
       Web UI: http://localhost:9800/session/019cebb1-xxx
       ❯ _
```

## 四、项目目录结构（最终）

```
cCli/
├── src/
│   ├── bridge/                    ← Bridge Server 后端（纯路由器）
│   │   ├── server.ts                  Hono HTTP + WebSocket 路由器
│   │   ├── client.ts                  CLI 端 WS 客户端（连接 Bridge，推/收事件）
│   │   └── index.ts                   导出 barrel
│   ├── core/
│   │   ├── event-bus.ts               进程内事件总线（本地 useChat ↔ BridgeClient）
│   │   ├── agent-loop.ts             （零改动）
│   │   └── ...
│   ├── commands/
│   │   ├── bridge.ts                  /bridge status | stop 指令
│   │   └── ...
│   ├── ui/                        ← CLI 终端 UI (Ink/React)
│   │   ├── useChat.ts                 事件广播到 EventBus + Web 输入回流监听
│   │   ├── App.tsx                    webEnabled 渲染 + /bridge 指令处理
│   │   └── ...
│   └── ...
├── web/                           ← Web 前端 (React SPA，独立 Vite 项目)
│   ├── package.json
│   ├── vite.config.ts
│   ├── index.html
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx                    URL 路由提取 sessionId
│   │   ├── hooks/
│   │   │   └── useWebSocket.ts        WS 连接 + register + 自动重连
│   │   ├── pages/
│   │   │   └── ChatPage.tsx           聊天主页（全部交互）
│   │   ├── components/
│   │   │   ├── MessageBubble.tsx       消息气泡（Markdown + 代码高亮）
│   │   │   ├── InputBar.tsx            输入框（流式中可打断）
│   │   │   ├── ToolStatus.tsx          工具状态（参数摘要 + 结果子块）
│   │   │   ├── PermissionCard.tsx      权限确认卡片
│   │   │   └── UserQuestionForm.tsx    AskUserQuestion 问卷表单
│   │   ├── types.ts                   共享类型定义
│   │   └── styles/
│   │       └── globals.css
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   └── tsconfig.json
└── ...
```

## 五、技术选型

| 组件 | 选择 | 理由 |
|------|------|------|
| HTTP Server | **Hono** | 轻量 (14KB)，Bun 原生支持 |
| 实时通信 | **WebSocket** (ws) | 双向通信，CLI 和 Web 都需要推/收 |
| 前端框架 | **React 18 + TypeScript** | 复用 React 生态，CLI 端已在用 React/Ink |
| 前端构建 | **Vite** | 快速 HMR，React 生态首选 |
| Markdown 渲染 | **react-markdown + rehype-highlight** | 代码高亮 |
| 样式方案 | **Tailwind CSS** | 快速搭 UI，后期可切原生 |
| EventBus | **自研 (~90行)** | 进程内同步广播，跨进程走 WebSocket |

**技术栈选型的核心原则：所有组件都必须 Bun 原生兼容。** Hono、Vite、libsql 三件套是专门为 Bun 迁移路线选定的。

### 5.1 Bun.js 兼容性评估

当前技术栈在 Node.js 上运行，切 Bun 时的具体变化：

| 组件 | 当前 (Node) | 切 Bun 后 | 改动量 |
|------|------------|----------|--------|
| **Hono HTTP** | `@hono/node-server` 适配器 | `Bun.serve()` 直连，不需要适配器 | 改 server.ts 约 5 行 |
| **WebSocket (服务端)** | `@hono/node-ws` 适配器 | `Bun.serve({ websocket })` 原生支持 | 改 server.ts 初始化 |
| **WebSocket (客户端)** | `ws` npm 包 | `new WebSocket()` Bun 全局内置 | 改 client.ts 1 行 import |
| **Vite** | `npx vite` | `bun run vite` | 零改动（Vite 是运行时无关的构建工具） |
| **React** | 不变 | 不变 | 零改动 |
| **Tailwind** | 不变 | 不变 | 零改动 |
| **libsql** | 已替换 better-sqlite3 | Node + Bun + Deno 全兼容 | 零改动 |

**关键认知**：
- **Vite 不是 React 的东西** — 它是通用前端构建工具，支持 React/Vue/Svelte/vanilla 等，Bun 原生能跑
- **Hono 就是为 Bun 设计的** — Bun 生态首选 Web 框架，当前用 `@hono/node-server` 只是 Node 适配器层
- **切 Bun 的改动集中在 `src/bridge/server.ts`** — 大约 20 行代码，替换服务启动方式

切换示意：

```typescript
// 当前 Node 版本
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
server = serve({ fetch: app.fetch, port })

// 切 Bun 后
export default {
  port,
  fetch: app.fetch,
  websocket: { ... }
}
```

## 六、关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| Bridge Server 角色 | 纯路由器，不持有 EventBus/AgentLoop | 解耦，所有 CLI 地位平等 |
| 客户端身份 | register 消息声明 cli/web + sessionId | 按 sessionId 隔离路由 |
| CLI 连接方式 | 所有 CLI（包括启动者）都通过 WebSocket 连接 | 无一等/二等公民 |
| 前端目录 | `web/` 与 `src/` 平级 | 前后端构建解耦，Vite 和 tsup 互不干扰 |
| 后端目录 | `src/bridge/` | 准确反映"桥接层"职责，区别于 `src/ui/`（CLI UI） |
| 历史还原 | 方案 B：解析 session JSONL 文件 | 完整还原工具执行记录，支持刷新/重连恢复 |
| Session 创建时机 | 即时创建（见下文 6.1） | Bridge 路由的身份基础，不能惰性 |
| Bridge 管控 | 所有人都有权关闭（/bridge stop + Web 按钮 + REST API） | 平等权限 |
| 端口冲突 | 检测已占用则跳过启动，作为客户端连接 | 多终端共享同一个 Bridge |
| Web UI 地址 | Ink 组件内 InputBar 上方常驻渲染 | 不被 WelcomeScreen 覆盖 |

### 6.1 Session 生命周期重构（根本性调整）

**原始设计**：Session 在用户第一次发消息时惰性创建（`submit()` → `ensureSession()`）。设计初衷是启动不一定会对话，不浪费 JSONL 文件。

**问题**：Bridge 架构中 sessionId 是路由的身份基础。所有消息按 sessionId 隔离分发，CLI 注册时必须带 sessionId，Web 连接时必须知道订阅哪个 session。惰性创建意味着启动后、首次对话前，整个路由体系处于"无 ID 可用"的状态。

**重构**：改为 useChat hook mount 时立即创建。

```
原来: CLI 启动 → 无 session → 用户发消息 → 创建 session → 路由生效
现在: CLI 启动 → useChat mount → ensureSession() → session 立即可用 → 路由立即生效
```

**安全性**：
- `ensureSession` 幂等（内部 `if (this.#sessionId) return`），后续 submit 不会重复创建
- 性能影响为零（同步写一行 JSONL）
- 空 session 文件由 `/gc` 指令清理

**设计启示**：当一个资源从"可选附属品"变为"基础设施的身份凭证"时，惰性初始化必须改为即时初始化。识别信号是多个模块开始依赖它的**存在性**而非**内容**。
| 端口冲突 | 检测已占用则跳过启动，作为客户端连接 | 多终端共享同一个 Bridge |
| Web UI 地址 | Ink 组件内 InputBar 上方常驻渲染 | 不被 WelcomeScreen 覆盖 |

## 七、后续规划

### Phase 2：Dashboard 看板

```
新增页面（web/src/pages/）:
  ├── OverviewPage.tsx        — 总览大盘（token 趋势、模型分布、费用排行）
  ├── ConversationsPage.tsx   — 对话详情（历史会话、对话回放）
  ├── LogsPage.tsx            — 日志浏览（实时日志流、按类型筛选）
  └── SettingsPage.tsx        — 设置管理（模型配置、计价规则 CRUD）

新增 API（src/bridge/server.ts 或独立路由文件）:
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

- 对话分支可视化（fork 树状图）
- 代码 Diff 视图（Monaco Editor 集成）
- MCP Server 管理界面
- 多会话标签页 + 切换 UI
- 移动端响应式适配
- Bridge Server 守护进程化（可选）
