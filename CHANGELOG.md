# Changelog

本文件记录 CCode CLI 各版本的主要变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/)。

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
