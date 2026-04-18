# Changelog

本文件记录 CCode CLI 各版本的主要变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/)。

---

## [0.13.0] - 2026-04-18

### Changed
- **CLI 启动 7 倍提速**：`tsup` 全量 bundle（`noExternal: [/.*/]` + `force-external` plugin），`node dist/bin/ccli.js --version` 3.3s → ~0.46s。source 代码零改动，仅 `tsup.config.ts` 和构建产物变化。
- **Agent 工具描述优化**：`dispatch_agent` 描述加入"如何选择 `run_in_background`"判断指引，引导 LLM 对独立闭环任务（搭项目、长构建、完整交付）优先后台执行，避免主 Agent 空转等待。
- **AgentLoop.run() 类型收紧**：返回类型从 `AsyncIterable<AgentEvent>` 改为 `AsyncGenerator<AgentEvent, void, unknown>`，配套沉淀 Node.js 异步迭代原理长文。

### Added
- **subagent_spawn 事件**：`dispatch_agent` 注册完子 Agent 后立即 yield 携带 `parentToolCallId` 的事件，UI 在 running 期间就能把工具调用和 SubAgentCard 绑定，不再等 `tool_done`。
- **子 Agent 停止 guidance**：`StopReport` 新增 `guidance` 字段，用自然语言告知主 Agent "用户主动停止"与"失败"的区别，避免主 Agent 自作主张接手任务。
- **Web 主界面 SubAgentCard 挂载**：ChatPage 订阅 `subagent_spawn`，running 期间实时渲染卡片，状态图标加 `animate-spin` 旋转动画（和抽屉内表现一致）。
- **ToolContext.toolCallId**：`StreamableTool` 可在 yield 事件时携带父工具调用 ID。

### Fixed
- **Web 端停止子 Agent 按钮失效**：Bridge Server 补齐 `subagent_stop` 消息类型的转发。
- **SubAgentDrawer button 嵌套 HTML 违规**：外层折叠触发器改为 `div + role="button"`（键盘支持保留），消除 React 的 "button cannot be a descendant of button" 警告。
- **shrink-0 属性错位**：EventLine 里的 `shrink-0` 原本被当作布尔属性附加到 span 上，移回 className。

### Docs
- **Node-CLI 启动性能优化全景**：新增"方案 E 实施记录"章节，包含 3 个真实踩坑（react-devtools-core 解析失败 / ESM 不支持 CJS require / tsup 字段 external 被 noExternal 覆盖）的现象/根因/解法、最终 `tsup.config.ts`、实测收益表、7 条可复用经验。
- **Web 主界面 SubAgent 卡片挂载修复**：沉淀根因链路 + 方案选型对比 + 时序图。
- **AsyncIterable 与 AsyncGenerator 魔法细节**：深度技术文档讲 Node.js 异步迭代协议、`async function*` 运行时魔法、改造收益评估。
- **数据库迁移与版本号诊断指南**：扩充 7.3 节版本号查询路径 + 新增 3.4 节迁移触发时机。

---

## [0.11.0] - 2026-04-14

### Added
- **keybinding 基线测试**：新增 5 个 UI 组件按键交互测试（37 用例），覆盖 InputBar/PermissionDialog/ModelPicker/ForkPanel/McpStatusView
- **E2E 测试恢复**：恢复误删的 SubAgent 全栈 E2E 测试脚本（Shell + TS 版）

### Changed
- **ink 5 → 6.8.0**：终端 UI 框架升级，消除 ink-multiline-input 的 peer dependency 冲突
- **react 18 → 19.2.5**：CLI 端（Ink）和 Web 端双端统一升级，零代码变更
- **react-dom 18 → 19.2.5**：Web 端同步升级
- **版本号收敛**：bin/ccli.ts 的硬编码 VERSION 改为 import APP_VERSION，bump 版本时只需改 3 处（version.ts + 2 个 package.json）

### Fixed
- **bin/ccli.ts 版本号滞后**：--help / --version 输出的版本号从 0.8.3 修正为当前版本

---

## [0.10.0] - 2026-04-13

### Added
- **工具执行计时器**：CLI 和 Web 端在工具执行超过 3 秒后显示实时秒数，消除长命令"卡死感"
- **Git 专用工具**：新增 `git` 工具（status/diff/commit/branch/merge/log/stash 等子命令），启动时自动注入 Git 上下文
- **SubAgent 独立模型**：子 Agent 可配置独立的 model/provider，支持 `subAgentModel` 三级优先级
- **Memory Web 管理**：Web Dashboard 新增记忆向量可视化（散点图 + 条目列表）
- **会话分支**：JSONL 持久化支持 parentUuid 分支，resume 时可选择分支

### Fixed
- **SubAgent 会话回放关联断裂**：修复 dispatch_agent → JSONL → Web 的 agentId 链路（正则 bug + 缺少结构化字段 + 停止按钮未接通）
- **ContextTracker 子 Agent 覆盖**：子 Agent 的 LLM 调用不再污染主 Agent 的上下文追踪统计
- **ClientMessage 类型缺失**：Web 端 permission 消息补全 `always` 字段

### Changed
- 版本号统一收口到 `src/version.ts`，消除硬编码
- 能力清单文档更新至 v0.9.0（11 处变更）
- `.gitignore` 新增 `.ccode/`、`.specstory/`、`nul` 规则

---

## [0.9.0] - 2026-04-09

### Added
- **SubAgent 一期**：`dispatch_agent` 工具实现嵌套 Agent 编排，独立 JSONL 会话隔离
- **Skills 引擎**：解析/加载/内置 skill，支持 `@skill` 调用
- **Runtime Plugins**：插件目录扫描 + Claude Code 插件导入
- **MCP 协议集成**：stdio / SSE / streamable-http 三种传输
- **Web Dashboard**：Hono + React SPA，实时 WebSocket 推送
- **长对话渲染优化**：Static 固化 + 流式气泡，解决 Ink 重渲染卡顿

### Fixed
- 长对话开始时清屏移除 WelcomeScreen 残留

---

## [0.8.3] - 2026-03-28

### Added
- **混合 RAG 记忆系统**：BM25 关键词 + 向量语义双路检索，jieba 中文分词
- **Token 计量与计价**：libSQL 持久化用量日志，Dashboard 总览大盘

### Fixed
- 多模型切换时 Provider 实例泄漏

---

## [0.8.2] - 2026-03-20

### Added
- **并行工具执行器**：安全工具自动并行，危险工具串行 + 权限门控
- **重复检测**：LLM 循环调用同一工具时自动拦截

---

## [0.8.1] - 2026-03-15

### Added
- **Pipe 模式**：`echo "question" | ccode` 非交互管道输入
- **Anthropic 原生协议**：支持 extended thinking、prompt cache

---

## [0.8.0] - 2026-03-10

### Added
- 初始公开发布
- 多模型支持：Claude / OpenAI / GLM / DeepSeek / Ollama
- 内置工具集：read_file / write_file / edit_file / bash / glob / grep
- React/Ink 终端 UI
- JSONL 会话持久化与 resume
