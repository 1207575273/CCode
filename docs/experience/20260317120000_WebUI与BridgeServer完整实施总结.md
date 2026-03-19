> 备注：项目原名 ZCli，2026-03-20 更名为 cCli（品牌名 CCode），详见 01_需求与项目管理核心文档/20260320030000_项目改名_ZCli到CCode.md

# Phase 1 完整实施总结

> 时间跨度: 2026-03-14 ~ 2026-03-17
> 提交数: 69 个
> 改动量: 93 文件，+11763 / -432 行

---

## 一、本期交付清单

### 1.1 新增能力

| 能力 | 说明 |
|------|------|
| **Bridge Server** | 纯消息路由器，所有 CLI 平等连接，按 sessionId 隔离 |
| **Web UI 聊天** | React SPA，CLI ↔ Web 双向实时同步，消息/工具/权限/问卷全覆盖 |
| **Dashboard 总览** | 当日/本周/本月/自定义 token 统计，折线图 + 饼图 + 模型明细表 |
| **Dashboard 对话** | 历史会话列表 + 搜索 + 瀑布流回放（4 档速度控制） |
| **Dashboard 设置** | Provider 配置查看（API Key 显隐）+ 计价规则 CRUD |
| **Dashboard 日志** | 占位页面（后做） |
| **kill_shell 工具** | 终止后台进程 + 进程追踪器 + 9 个测试用例 |
| **Session 即时创建** | useChat mount 时立即创建，不等首次对话 |
| **JSONL 工具还原** | loadMessages 提取 tool_call_start/end，刷新不丢工具历史 |
| **BSL 1.1 协议** | 商业使用需授权，2030 年转 Apache 2.0 |
| **libsql 替换** | better-sqlite3 → libsql，解除 Bun.js 迁移硬阻塞 |

### 1.2 架构调整

| 调整 | 原来 | 现在 |
|------|------|------|
| **Web 服务层** | `src/bridge/` + `src/dashboard/` 两个一级目录 | `src/server/bridge/` + `src/server/dashboard/` 收敛到 `server/` |
| **前端目录** | `dashboard-ui/` | `web/`（更简洁） |
| **Bridge 架构** | 本地 EventBus 直连（一等/二等公民） | 纯路由器 + 全员 WebSocket 客户端（平等） |
| **Session 时机** | 惰性创建（首次 submit） | 即时创建（useChat mount） |
| **SQLite** | better-sqlite3（Bun 不兼容） | libsql（Node/Bun/Deno 全兼容） |
| **计价规则** | 21 条（过多） | 13 条（精简到实际使用的模型） |

### 1.3 文档产出

| 文档 | 位置 |
|------|------|
| Bridge Server 架构调研与规划 | `docs/plans/20260314230000_*` |
| Bridge Server 实施总结 | `docs/plans/20260315030000_*` |
| Session 生命周期与项目架构 | `docs/02_项目架构能力收敛/20260315040000_*` |
| ZCli 完整能力清单 | `docs/02_项目架构能力收敛/20260315050000_*` |
| Web UI 踩坑与前端工程经验（11 章） | `docs/experience/20260315120000_*` |
| AgentLoop 事件模型重构规划 | `docs/plans/20260315140000_*` |
| KillShell 工具设计与实施 | `docs/plans/20260315190000_*` |
| Dashboard 管理界面实施规划 | `docs/plans/20260315200000_*` |
| SQLite 替换评估与 RAG 规划 | `docs/plans/20260314200000_*` |
| SQLite 替换实施记录 | `docs/plans/20260314210000_*` |
| SystemPrompt 优化规划 | `docs/plans/20260314220000_*` |

---

## 二、最终目录结构

```
cCli/
├── bin/zcli.ts                    CLI 入口（交互/Pipe/Web 三模式）
├── src/
│   ├── core/                      核心引擎
│   │   ├── agent-loop.ts             AgentLoop（零改动）
│   │   ├── event-bus.ts              进程内事件总线
│   │   ├── bootstrap.ts              启动编排
│   │   └── ...
│   ├── server/                    Web 服务层（收敛入口）
│   │   ├── bridge/                   WebSocket 消息路由
│   │   │   ├── server.ts                Hono app + WS 路由
│   │   │   ├── client.ts               CLI 端 WS 客户端
│   │   │   └── index.ts
│   │   └── dashboard/                REST API
│   │       └── api.ts                   9 个端点
│   ├── tools/                     工具系统
│   │   ├── bash.ts                   Shell 执行（改造：注册后台 PID）
│   │   ├── kill-shell.ts             终止后台进程（新增）
│   │   ├── process-tracker.ts        进程追踪器（新增）
│   │   └── ...
│   ├── ui/                        CLI 终端 UI
│   ├── commands/                  斜杠指令（新增 /bridge）
│   ├── persistence/               持久化（loadMessages 增强）
│   ├── observability/             可观测性
│   └── ...
├── web/                           Web 前端（React SPA）
│   ├── src/
│   │   ├── App.tsx                   BrowserRouter 路由
│   │   ├── components/
│   │   │   ├── Sidebar.tsx              侧边导航
│   │   │   ├── MessageBubble.tsx        消息气泡（Markdown + GFM + 代码高亮）
│   │   │   ├── ToolStatus.tsx           工具状态（实时 + 历史统一）
│   │   │   ├── InputBar.tsx             输入框
│   │   │   ├── PermissionCard.tsx       权限确认
│   │   │   └── UserQuestionForm.tsx     问卷表单
│   │   ├── pages/
│   │   │   ├── ChatPage.tsx             聊天（WebSocket 双向同步）
│   │   │   ├── OverviewPage.tsx         总览大盘（折线图 + 饼图）
│   │   │   ├── ConversationsPage.tsx    对话历史（搜索 + 瀑布流回放）
│   │   │   ├── SettingsPage.tsx         设置管理（Provider + 计价规则）
│   │   │   └── LogsPage.tsx             日志（占位）
│   │   ├── hooks/
│   │   │   ├── useWebSocket.ts          WS 连接（callback + StrictMode 防护）
│   │   │   └── useApi.ts               REST API fetch 封装
│   │   └── types.ts
│   ├── package.json
│   ├── vite.config.ts
│   └── tailwind.config.js
└── tests/
```

---

## 三、技术栈全貌

| 层 | 技术 |
|----|------|
| CLI 运行时 | Node.js 20 + TypeScript 5 (strict) |
| CLI UI | Ink 5 + React 18 |
| Web Server | Hono（HTTP + WebSocket） |
| Web 前端 | React 18 + Vite + Tailwind CSS |
| 前端路由 | react-router-dom |
| 前端图表 | recharts |
| Markdown | react-markdown + remark-gfm + rehype-highlight |
| 实时通信 | WebSocket (ws) |
| 持久化 | JSONL (sessions) + libsql/SQLite (usage/pricing) |
| 测试 | Vitest (54 文件, 411 用例) |
| 构建 | tsup (CLI) + Vite (Web) |
| 协议 | BSL 1.1 |

---

## 四、架构演进关键节点

### 4.1 Bridge Server 三阶段

```
阶段一: 本地 EventBus 直连
  → 单进程能用，多终端不行（事件不跨进程）

阶段二: 多进程但不平等
  → 第一个 CLI 是"地主"拥有 Bridge，第二个是"佃户"
  → session 串台（无隔离）

阶段三: 纯路由器 + 全员平等
  → Bridge Server 不持有 EventBus/AgentLoop
  → 所有 CLI（含启动者）通过 WebSocket 连接
  → 按 sessionId 隔离路由
  → 任何人可 /bridge stop 关闭
```

### 4.2 Session 生命周期重构

```
原来: CLI 启动 → 无 session → 用户发消息 → 创建 session
现在: CLI 启动 → useChat mount → ensureSession() → session 立即可用

触发原因: Bridge 路由需要 sessionId 作为身份凭证，不能惰性
安全性: ensureSession 幂等，性能零影响
```

### 4.3 目录结构收敛

```
原来: src/bridge/ + src/dashboard/ + dashboard-ui/（3 个一级目录）
现在: src/server/{bridge,dashboard} + web/（1+1 个一级目录）
```

---

## 五、踩坑精华（11 个问题）

| # | 问题 | 根因 | 影响 |
|---|------|------|------|
| 1 | import `.js` 后缀 | CLI(Node ESM) 需要，Web(Vite) 不需要 | 白屏 |
| 2 | `.js` 产物污染 | IDE 后台编译混入 | 加载旧代码 |
| 3 | 工具渲染顺序 | text 和 tool 交替但被攒着输出 | 顺序错乱 |
| 4 | 工具历史样式 | 实时/历史两套组件 | 样式不一致 |
| 5 | 消息三重 echo | 事件回路无断路 | 重复显示 |
| 6 | WS 被反代拦截 | `app.all('*')` 吞了 `/ws` | 连接失败 |
| 7 | sessionId 不匹配 | Web 空 ID vs CLI 真实 ID | 消息不通 |
| 8 | 生产静态资源 404 | `import.meta.dirname` 构建后变 | 路径错 |
| 9 | **StrictMode + WS** | **effect 重放 + onclose 重连 = 幽灵连接** | **文本翻倍** |
| 10 | 刷新丢工具历史 | loadMessages 只取 user/assistant | 工具记录消失 |
| 11 | 字段名不匹配 | API 返回 updatedAt，前端用 createdAt | 列表空 |

**最难的是第 9 个**——从"Markdown 渲染乱码"的表象，经过 5 轮排查（ReactMarkdown → 事件丢失 → DOM 分帧 → 文本翻倍 → 幽灵连接），最终定位到 React StrictMode + WebSocket onclose 自动重连的组合陷阱。

---

## 六、REST API 清单

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | /api/health | 健康检查 + 活跃 session |
| POST | /api/bridge/stop | 关闭 Bridge Server |
| GET | /api/overview | 总览大盘（当日/周/月/自定义 + 趋势 + 饼图） |
| GET | /api/conversations | 对话列表 |
| GET | /api/conversations/:id | 对话详情（含工具记录） |
| GET | /api/settings | 读取配置 |
| POST | /api/settings/save | 保存配置 |
| GET | /api/pricing | 计价规则列表 |
| POST | /api/pricing/add | 新增规则 |
| POST | /api/pricing/update | 更新规则 |
| POST | /api/pricing/delete | 删除规则 |

---

## 七、测试覆盖

| 模块 | 文件数 | 用例数 |
|------|--------|--------|
| EventBus | 1 | 5 |
| KillShell + ProcessTracker | 1 | 9 |
| TokenMeter | 1 | 9 |
| DB | 1 | 5 |
| CleanupService | 1 | 9 |
| 其他（bash/tools/commands/ui/...） | 49 | 374 |
| **总计** | **54** | **411** |

---

## 八、遗留与后续

### 已规划待实施

| 事项 | 文档 | 优先级 |
|------|------|--------|
| AgentLoop 事件模型重构（llm_done） | `20260315140000_*` | P1 |
| SystemPrompt Prompt Cache 优化 | `20260314220000_*` | P1 |
| libsql 向量搜索 + RAG | `20260314200000_*` | P2 |
| 日志浏览页面（LogsPage） | Dashboard 规划 | P2 |
| Bun.js 迁移 | 兼容性审查报告 | P2 |

### 已知问题

| 问题 | 影响 | 优先级 |
|------|------|--------|
| Bridge Server 跟第一个 CLI 进程 | 第一个退出 Bridge 关闭 | P2 |
| Web 端 highlight.js CSS 不完整 | 部分语言代码块无高亮 | P3 |
| 总览页图表在无数据时布局空 | 视觉不佳 | P3 |

---

## 九、经验沉淀

### 9.1 工程原则

1. **两个 TypeScript 项目共处一仓，构建链完全独立** — CLI(tsup/Node ESM) 和 Web(Vite/bundler) 的 import 规范、模块解析、产物格式全部不同，不能互相复制
2. **惰性初始化不是银弹** — 当资源从"可选"变为"基础设施身份凭证"时，必须改为即时初始化
3. **同类数据只用一个组件渲染** — "实时"和"历史"是状态不同，不是两个东西
4. **改持久化层比改 UI 层更有效** — 一处 loadMessages 改动，CLI + Web + 未来回放全部受益
5. **WebSocket + React StrictMode 是经典陷阱** — connect 前关旧连接 + onclose 检查身份 + cleanup 不触发重连，三个防护缺一不可
6. **目录结构要收敛** — 相关模块挂同一父目录（`server/{bridge,dashboard}`），不让一级目录膨胀

### 9.2 开发流程

1. 先分析架构 → 写方案文档 → 确认后开干
2. 每个改动 TS 编译检查 + 全量测试 → 再提交
3. 遇到难查的 bug 加调试日志 → 看数据 → 定位根因 → 修完再清日志
4. 文档跟代码同步更新，不欠债
