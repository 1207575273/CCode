> 备注：项目原名 ZCli，2026-03-20 更名为 cCli（品牌名 CCode），详见 01_需求与项目管理核心文档/20260320030000_项目改名_ZCli到CCode.md

# Bridge Server 与 Web UI 实施总结

> 日期: 2026-03-15
> 版本: Phase 1 完成
> 涉及提交: bd34db6 → 5ed2a08（共 22 个提交）

---

## 一、背景与目标

### 1.1 为什么要做 Web UI

ZCli 是一个终端 AI 编程助手（类 Claude Code），核心交互全在终端内完成。但终端有天然局限：

- **Markdown/代码渲染受限** — 终端无法渲染富文本、代码高亮、Diff 视图
- **不方便分享和回顾** — 终端输出滚走就没了，翻历史不方便
- **多设备协作** — 想在手机/平板上看对话进度，终端做不到
- **Dashboard 需求** — Token 消耗大盘、历史对话回放、设置管理等需要 Web 界面

### 1.2 核心需求

不是简单的"CLI 旁边开个网页"，而是：

1. **CLI 里对话 → Web 界面实时同步显示**
2. **Web 界面对话 → CLI 里实时同步显示**
3. **两端共享同一个 AgentLoop 实例、同一个会话上下文**
4. **后期可扩展：Dashboard 看板、对话回放、设置管理**

一句话：**双向实时同步，两端是同一个对话的两个视图。**

### 1.3 参考方案调研

| 方案 | 来源 | 做法 | 局限 |
|------|------|------|------|
| Companion 模式 | Claude Code 官方 | `--sdk-url` 把终端输出重定向到 WebSocket | 单向，Web 输入能力有限 |
| claude-code-web | 社区 | node-pty + xterm.js 终端镜像 | 本质是远程终端，无法做独立 Web UI |
| claude-code-server | 社区 | WebSocket 推 stdout/stderr | 同上 |
| Claude Remote | 社区 | tmux 会话持久化 + diff 推送 | 适合远程，不适合双向对话融合 |

**结论**：业界方案都是"终端镜像"模式，无法满足我们的双向融合需求。需要自己设计。

---

## 二、架构演进（三个阶段）

### 2.1 阶段一：本地 EventBus 直连（初版）

```
CLI 进程内:
  AgentLoop → useChat → EventBus（本地）→ Bridge Server → WebSocket → Web
  Web 输入 → Bridge Server → EventBus → useChat → AgentLoop
```

**特点**：
- EventBus 是进程内的发布-订阅总线
- Bridge Server 直接订阅本地 EventBus
- 简单直接，单进程内完美工作

**问题**：
- 第二个 CLI 进程的事件到不了 Bridge Server（EventBus 是进程局部的）
- 第一个 CLI 是"地主"（拥有 Bridge），第二个是"佃户"（只能连接）
- 第一个退出，Bridge 死，全部断开

### 2.2 阶段二：多进程但不平等（发现问题）

尝试让第二个 CLI 检测到端口已占用就跳过 Bridge 启动。

**暴露的问题**：
- 终端 1 的消息跑到终端 2 的 Web 界面去了 — 没有 session 隔离
- 终端 2 的事件根本到不了 Web — EventBus 是进程局部的
- 谁是第一个启动的是随机的，但第一个有特权 — 不合理

### 2.3 阶段三：纯路由器 + 全员平等（最终方案）

```
Bridge Server (port 9800) — 纯消息路由器，无业务逻辑
  │
  │  session registry: sessionId → [clients...]
  │
  ├── CLI-1 (ws client, session-111) — 推事件 / 收 Web 输入
  ├── CLI-2 (ws client, session-222) — 推事件 / 收 Web 输入
  ├── Web-A (ws client, session-111) — 收事件 / 发输入
  └── Web-B (ws client, session-222) — 收事件 / 发输入
```

**核心设计决策**：

| 决策 | 选择 | 理由 |
|------|------|------|
| Bridge Server 角色 | 纯路由器，不持有 EventBus/AgentLoop | 解耦，谁退出都不影响路由逻辑 |
| 客户端身份 | register 消息声明 cli/web + sessionId | 按 sessionId 隔离，同 session 内路由 |
| CLI 连接方式 | 所有 CLI（包括启动者）都通过 WebSocket 连接 | 地位完全平等 |
| session 隔离 | CLI 推的事件只到同 session 的 Web | 多终端互不干扰 |
| Bridge 生命周期 | 跟第一个 CLI 进程，退出则关闭 | 简单，不引入守护进程复杂度 |
| Bridge 管控 | 所有人都有权关闭（/bridge stop + Web 按钮） | 平等权限 |

---

## 三、关键模块详解

### 3.1 EventBus（`src/core/event-bus.ts`）

进程内事件总线，CLI 本地的双向广播中枢。

```typescript
export type BusEvent = AgentEvent | BridgeEvent

export class EventBus {
  on(handler): () => void        // 订阅，返回取消函数
  onType(type, handler): () => void  // 按类型过滤订阅
  emit(event): void              // 广播（handler 异常隔离）
  getClients(): ConnectedClient[] // 已连接客户端
}

export const eventBus = new EventBus()  // 全局单例
```

**职责变化**：
- 初版：CLI ↔ Web 的唯一通道
- 最终版：仅用于进程内事件分发（useChat ↔ BridgeClient），跨进程通信由 WebSocket 完成

### 3.2 Bridge Server（`src/bridge/server.ts`）

Hono HTTP + WebSocket 服务，纯消息路由器。

**WebSocket 协议**：

```
连接后第一条消息 — register:
  { type: 'register', clientType: 'cli'|'web', sessionId: '019cebb1-xxx' }

CLI → Bridge (推送事件):
  { type: 'event', payload: { type: 'text', text: '...' } }

Web → Bridge (用户输入):
  { type: 'chat', text: '...' }
  { type: 'permission', allow: true }
  { type: 'question', cancelled: false, answers: {...} }
  { type: 'abort' }

Bridge → Web (转发事件):
  { type: 'text', text: '...' }
  { type: 'tool_start', toolName: '...', ... }
  { type: 'session_init', sessionId: '...', messages: [...] }

任何人 → Bridge:
  { type: 'bridge_stop' }  // 关闭 Bridge Server
```

**路由规则**：
- CLI 推的 `event` → 解包 `payload` → 广播给同 sessionId 的 Web 客户端
- Web 发的 `chat/permission/question/abort` → 转发给同 sessionId 的 CLI 客户端
- `register` → 记录身份和 sessionId；Web 空 sessionId 时自动分配第一个活跃 CLI session
- `bridge_stop` → 通知所有客户端后关闭

**附加功能**：
- `GET /api/health` — 健康检查 + 活跃 session 列表
- `POST /api/bridge/stop` — REST 方式关闭 Bridge
- Dev 模式反向代理 Vite（排除 `/ws` 和 `/api/` 路径）
- 生产模式托管 `web/dist/` 静态资源

### 3.3 Bridge Client（`src/bridge/client.ts`）

CLI 端 WebSocket 客户端，连接 Bridge Server。

**职责**：
1. 连接 Bridge，发送 `register` 声明 cli 身份 + sessionId
2. 订阅本地 EventBus，将 AgentEvent 包装为 `{ type: 'event', payload }` 推给 Bridge
3. 接收 Bridge 转发的 Web 输入，发布到本地 EventBus
4. 自动重连（2s 间隔）
5. 收到 `bridge_stop` 时断开不重连

**事件过滤**：
- 内部管理事件（client_connect/disconnect、permission_response、question_response）不推
- Web 端回流的 user_input（source: 'web'）不推回 Bridge（防循环）
- AgentEvent 中含回调函数的（permission_request、user_question_request）需序列化去除回调

### 3.4 Web 前端（`web/`）

独立 React SPA 项目（Vite + Tailwind），与 `src/` 平级。

**核心组件**：

| 组件 | 职责 |
|------|------|
| `useWebSocket.ts` | WebSocket 连接管理 + register + 自动重连 |
| `ChatPage.tsx` | 主页面，组装所有组件，处理全部 ServerEvent |
| `MessageBubble.tsx` | 消息气泡，ReactMarkdown + rehype-highlight |
| `InputBar.tsx` | 输入框，Enter 发送，流式中可打断 |
| `ToolStatus.tsx` | 工具执行状态：参数摘要 + 结果子块 |
| `PermissionCard.tsx` | 权限确认卡片 |
| `UserQuestionForm.tsx` | AskUserQuestion 问卷表单 |

**Session 机制**：
- URL 路由：`/session/:sessionId` 指定连接哪个 session
- 直接访问 `/` 时由 Bridge 自动分配活跃 session
- 连接后收到 `session_init` → 还原 JSONL 历史消息 → 更新 URL

---

## 四、Session 生命周期重构

这是本次改造中一个根本性的架构调整，影响面远超 Web UI 本身。

### 4.1 原始设计（惰性创建）

```
CLI 启动 → 无 session
  → 用户第一次发消息 → submit()
    → sessionLogger.ensureSession(provider, model)
      → sessionStore.create() 写入 session_start JSONL
      → 返回 sessionId
  → 后续 submit 调用 ensureSession → 幂等返回已有 ID
```

**设计初衷**：启动不一定会对话（用户可能只是看看 /help），不浪费 JSONL 文件。

### 4.2 问题暴露

引入 Bridge Server 后，session 的惰性创建导致一连串问题：

1. **Bridge 连接时 sessionId 为 null** — Web 客户端连接时 `getCurrentSessionId()` 返回 null，无法推送历史消息，无法路由
2. **Web UI 地址无法显示 sessionId** — 启动时没有 sessionId，URL 不完整
3. **Bridge Client 无法 register** — 没有 sessionId 就无法声明身份，消息路由不工作
4. **多终端 session 隔离失败** — 没有 sessionId 的 CLI 无法被区分

本质原因：**session 是 Bridge 架构的路由基础，不是可选的**。惰性创建与"session 即身份"的新架构矛盾。

### 4.3 重构方案（即时创建）

```
CLI 启动 → render() → useChat mount
  → useEffect 立即调用 ensureSession(provider, model)
    → sessionStore.create() 写入 session_start JSONL
    → sessionId 立即可用
  → Bridge Client 拿到 sessionId → register → 路由生效
  → Web UI 显示完整 URL: /session/{sessionId}
```

**改动**：在 `useChat` hook 中新增一个 `useEffect`：

```typescript
useEffect(() => {
  if (currentProvider && currentModel) {
    sessionLogger.ensureSession(currentProvider, currentModel)
  }
}, [])
```

**为什么这样做是安全的**：
- `ensureSession` 本身是幂等的（`if (this.#sessionId) return`）
- 后续 submit 调用时直接返回已有 ID，不会重复创建
- 性能影响为零 — 就是同步写一行 JSONL（`session_start` 事件）
- 即使用户不对话直接退出，只多了一个空 session 文件，`/gc` 指令会清理

### 4.4 影响范围

| 模块 | 影响 |
|------|------|
| `useChat.ts` | 新增 mount useEffect，调 ensureSession |
| `sessionLogger` | 零改动（ensureSession 本身就是幂等的） |
| `bin/zcli.ts` | Bridge 连接时机从"启动时"改为"render 后 100ms"（等 session 创建） |
| Bridge Server | 连接时能拿到 sessionId，推送 session_init 正常工作 |
| Web 前端 | 连接后立即收到历史消息，URL 包含完整 sessionId |
| `/resume` 恢复 | 不受影响 — resume 走 `sessionLogger.bind()`，不走 ensureSession |

### 4.5 设计启示

**惰性初始化不是银弹**。当一个资源从"可选"变为"基础设施"时，惰性创建反而成为障碍。Session 在纯 CLI 模式下是"对话后才需要"的，但在 Bridge 架构下是"连接路由的身份凭证"，必须在对话前就存在。

识别这个时机变化的信号：**当多个模块开始依赖某个资源的存在性（而非内容）时，就该改为即时初始化。**

---

## 五、其他问题与解决

### 5.1 消息重复显示（事件回路）

**现象**：Web 发一条"你好"，页面显示三条。

**原因**：
1. Web 发 `chat` → Bridge → EventBus emit `user_input(web)` → Bridge 又推回给 Web（echo）
2. useChat 收到 web 输入 → 调 submit → submit 内部又 emit `user_input(cli)` → 再推给 Web

**解决**：
- Bridge Server 不 echo web 端的 `user_input` 回去
- `submit()` 增加 `_source` 参数，web 触发时不重复 emit
- Web 端本地 optimistic 添加用户消息，不依赖服务端 echo

### 5.2 WebSocket 连接失败

**现象**：`WebSocket connection to 'ws://localhost:9800/ws' failed`

**原因**：Dev 模式的 Vite 反代 `app.all('*')` 拦截了 `/ws` 路径，WebSocket 握手的 GET 请求被当作普通 HTTP 转给 Vite。

**解决**：反代排除 `/ws` 和 `/api/` 前缀路径，让 Bridge Server 自己处理。

### 5.3 多终端 session 串台

**现象**：终端 1 的消息出现在终端 2 的 Web 界面。

**原因**：初版 Bridge Server 订阅本地 EventBus，所有事件广播给所有 Web 客户端，没有 session 隔离。

**解决**：重构为纯路由器架构，所有客户端 register 时声明 sessionId，路由按 sessionId 隔离。

### 5.4 Web UI 地址被终端覆盖

**现象**：`process.stderr.write` 输出的 Web UI 地址闪一下就被 Ink 渲染覆盖。

**原因**：Ink 是全屏渲染框架，`stderr.write` 输出的内容会被 Ink 的重绘覆盖。

**解决**：不用 `stderr.write`，改为在 Ink 组件内渲染 Web UI 地址（InputBar 上方常驻显示）。

### 5.5 端口冲突崩溃

**现象**：第二个终端 `pnpm dev:web` 时 `EADDRINUSE` 崩溃。

**解决**：启动前用 `net.createServer` 探测端口，已占用则跳过 Bridge 启动，直接作为 WS 客户端连接。

### 5.6 Web 注册空 sessionId

**现象**：直接访问 `http://localhost:9800`（不带 `/session/xxx`），消息不通。

**原因**：Web register 带空 sessionId，与 CLI 的真实 sessionId 不匹配，路由找不到对方。

**解决**：Bridge Server 在 Web 注册空 sessionId 时，自动分配第一个活跃的 CLI session。

---

## 六、开发、构建与运行

### 6.1 三种运行模式

| 模式 | 命令 | Web 前端来源 | 适用场景 |
|------|------|-------------|---------|
| 纯 CLI | `pnpm dev` | 无 | 日常对话，不需要 Web |
| Dev + Web | `pnpm dev:web` | Vite dev server (HMR 热更新) | 开发 Web 前端，改代码即时刷新 |
| 生产 + Web | `node dist/bin/zcli.js --web` | Bridge 托管 `web/dist/` 静态文件 | 正式使用，单端口，无需 Vite |

### 6.2 开发模式（pnpm dev:web）

**首次准备**：

```bash
cd cCli
pnpm install          # CLI 依赖
cd web && pnpm install # Web 前端依赖
cd ..
```

**启动**：

```bash
pnpm dev:web
```

一条命令同时启动三个服务：

```
pnpm dev:web
  │
  ├─ 检测 9800 端口
  │   ├─ 空闲 → 启动 Bridge Server (Hono, port 9800)
  │   │         + Vite dev server (后台子进程, port 5173)
  │   └─ 已占用 → 跳过（复用已有 Bridge）
  │
  ├─ render() Ink UI → useChat mount → ensureSession() 创建 session
  │
  ├─ connectBridge(9800, sessionId) — CLI 作为 WS 客户端连接 Bridge
  │
  └─ 终端显示：
       bootstrap 1089ms (skills 220 → hooks 9 ...)
       Web UI: http://localhost:9800/session/019cebb1-xxx
       ❯ _
```

**Web 前端访问**：浏览器打开终端显示的 URL，Bridge Server 反代 Vite 返回页面。

**开发体验**：修改 `web/src/` 下的前端代码 → Vite HMR 即时刷新，无需重启 CLI。

### 6.3 生产构建

**构建命令**：

```bash
cd cCli

# 只构建 CLI
pnpm build             # → dist/

# 只构建 Web 前端
pnpm build:web         # → web/dist/

# 一次全构建
pnpm build:all         # → dist/ + web/dist/
```

**构建产物目录结构**：

```
cCli/
├── dist/                      ← CLI 构建产物 (tsup)
│   └── bin/
│       └── zcli.js                入口文件
├── web/
│   └── dist/                  ← Web 前端构建产物 (Vite)
│       ├── index.html             SPA 入口
│       └── assets/
│           ├── index-xxx.js       React SPA bundle (~450KB)
│           └── index-xxx.css      Tailwind CSS (~12KB)
└── ...
```

### 6.4 生产模式运行

```bash
# 构建
cd cCli && pnpm build:all

# 启动（纯 CLI）
node dist/bin/zcli.js

# 启动（带 Web UI）
node dist/bin/zcli.js --web
```

生产模式下 Bridge Server 直接托管 `web/dist/` 静态文件，**不需要 Vite**，单端口 9800 搞定一切。

```
node dist/bin/zcli.js --web
  │
  ├─ Bridge Server (port 9800)
  │   ├─ /ws           → WebSocket 消息路由
  │   ├─ /api/*        → REST API
  │   └─ /*            → 托管 web/dist/ 静态资源 (SPA fallback)
  │
  ├─ CLI 作为 WS 客户端连接 Bridge
  │
  └─ 浏览器访问 http://localhost:9800 → 加载 React SPA → WebSocket 连接
```

### 6.5 Web 客户端连接流程（通用）

不管 dev 还是生产模式，Web 端连接流程一致：

```
浏览器打开 http://localhost:9800/session/019cebb1-xxx
  │
  ├─ 加载 React SPA（dev: Vite 反代 / 生产: 静态文件）
  ├─ App.tsx 从 URL 提取 sessionId
  ├─ useWebSocket 连接 ws://localhost:9800/ws
  ├─ 发送 register { clientType: 'web', sessionId: '019cebb1-xxx' }
  ├─ Bridge Server 读 session JSONL → 推送 session_init { messages: [...] }
  ├─ ChatPage 还原历史消息 + 显示 sessionId + model
  │
  └─ 实时双向同步：
       CLI 输入 → Bridge → Web 显示
       Web 输入 → Bridge → CLI 执行 → 事件回流 → Web 显示
```

### 6.6 多终端共享 Bridge

```bash
# 终端 1：启动 Bridge Server
pnpm dev:web

# 终端 2：检测到 9800 已占用，跳过 Bridge，作为 WS 客户端连接
pnpm dev:web

# 两个终端各自独立对话，各自有独立 sessionId
# Web 端通过 /session/:id URL 路由访问不同 session
# 任一终端可 /bridge stop 关闭 Bridge
```

### 6.7 NPM 包发布（规划）

未来发布 npm 包时，`web/dist/` 需要包含在发布文件中：

```jsonc
// package.json
{
  "files": [
    "dist/",           // CLI 构建产物
    "web/dist/"        // Web 前端构建产物
  ]
}
```

用户安装后 `npx zcli --web` 直接可用，无需自己构建前端。

---

## 七、文件清单

### 新增文件

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/core/event-bus.ts` | ~90 | 进程内事件总线 |
| `src/bridge/server.ts` | ~240 | Bridge Server 纯路由器 |
| `src/bridge/client.ts` | ~150 | CLI 端 WS 客户端 |
| `src/bridge/index.ts` | 3 | 导出 barrel |
| `src/commands/bridge.ts` | ~30 | /bridge 指令 |
| `tests/unit/core/event-bus.test.ts` | ~60 | EventBus 单测 |
| `web/` | 独立项目 | React SPA 前端 |
| `web/src/hooks/useWebSocket.ts` | ~70 | WS 连接管理 |
| `web/src/pages/ChatPage.tsx` | ~230 | 聊天主页 |
| `web/src/components/MessageBubble.tsx` | ~35 | 消息气泡 |
| `web/src/components/InputBar.tsx` | ~45 | 输入框 |
| `web/src/components/ToolStatus.tsx` | ~55 | 工具状态 |
| `web/src/components/PermissionCard.tsx` | ~35 | 权限确认 |
| `web/src/components/UserQuestionForm.tsx` | ~110 | 问卷表单 |
| `web/src/types.ts` | ~55 | 共享类型 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `bin/zcli.ts` | --web 参数、Bridge 启动/连接逻辑、webEnabled prop |
| `src/ui/useChat.ts` | EventBus 广播 + Web 输入回流监听 + session 预创建 |
| `src/ui/App.tsx` | webEnabled 渲染 + /bridge 指令处理 + bootstrap 始终显示 |
| `src/commands/types.ts` | 新增 bridge_status/bridge_stop action |
| `package.json` | dev:web script + ws 依赖 |
| `tsconfig.json` | @bridge/* 路径别名 |

---

## 八、后续规划

### Phase 2：Dashboard 看板

- 总览大盘（Token 消耗趋势、模型分布、费用排行）
- 对话详情（历史会话列表、对话回放）
- 日志浏览（实时日志流、按类型筛选）
- 设置管理（模型配置、计价规则 CRUD）

### Phase 3：高级能力

- 对话分支可视化（fork 树状图）
- 代码 Diff 视图（Monaco Editor）
- MCP Server 管理界面
- 多会话标签页
- 移动端响应式适配

### 遗留问题

| 问题 | 影响 | 优先级 |
|------|------|--------|
| Bridge Server 守护进程化 | 第一个 CLI 退出 Bridge 关闭 | P2（当前可接受） |
| Vite HMR WebSocket 代理 | dev 模式热更新可能不稳定 | P2 |
| Web 端 Markdown 代码高亮 CSS | 需要引入 highlight.js 样式文件 | P1 |
| Web 端多 session 切换 UI | 当前只能通过 URL 路由切换 | P2 |
