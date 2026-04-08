# CCode

**开源多模型 AI 编程 CLI 助手** — 支持 GLM / Claude / DeepSeek / GPT / Gemini / Ollama 及任意 OpenAI 兼容模型

> **C** = **C**odeYang（作者）· **C**hina（中国开发者出品）· **C**ode Agent

[![npm](https://img.shields.io/npm/v/ccode-cli)](https://www.npmjs.com/package/ccode-cli)
[![GitHub](https://img.shields.io/github/stars/1207575273/CCode)](https://github.com/1207575273/CCode)

## 安装

```bash
npm install -g ccode-cli
```

## 快速配置

首次启动自动创建 `~/.ccode/config.json`，填入 API Key 即可使用：

```jsonc
{
  "defaultProvider": "glm",
  "defaultModel": "glm-5",
  "providers": {
    "glm": {
      "apiKey": "your-api-key",
      "baseURL": "https://open.bigmodel.cn/api/coding/paas/v4",
      "models": ["glm-5", "glm-4.7"]
    }
  }
}
```

> 本项目全程在智谱 GLM 模型下开发与测试。只要模型服务支持 **OpenAI Chat Completion** 或 **Anthropic Messages** 协议，配置 `baseURL` + `apiKey` 即可接入，无需任何代码改动。

### config.json 完整字段说明

```jsonc
{
  // ────── 全局设置 ──────
  "defaultProvider": "glm",          // 默认使用的 Provider 名称
  "defaultModel": "glm-5",           // 默认模型（必须在对应 provider.models 列表中）
  "statusBar": true,                 // 是否显示底部状态栏（token 消耗、模型名等）

  // ────── Provider 配置 ──────
  "providers": {
    "<provider-name>": {             // 自定义名称，如 "glm"、"anthropic"、"my-proxy"
      "apiKey": "sk-xxx",            // [必填] API 密钥
      "baseURL": "https://...",      // [可选] 自定义 API 端点（OpenAI 兼容协议必填）
      "protocol": "openai",          // [可选] 协议类型："openai"(默认) | "anthropic"
      "models": ["model-a", "model-b"],  // [必填] 该 provider 可用的模型列表
      "visionModels": ["model-a"]    // [可选] 支持图片理解的模型子集（默认空 = 全不支持）
    }
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `defaultProvider` | string | 是 | 启动时默认使用的 Provider |
| `defaultModel` | string | 是 | 启动时默认使用的模型 |
| `statusBar` | boolean | 否 | 底部状态栏开关，默认 `true` |
| `providers.<name>.apiKey` | string | 是 | API 密钥 |
| `providers.<name>.baseURL` | string | 否 | 自定义端点。Anthropic 可省略，OpenAI 兼容协议必填 |
| `providers.<name>.protocol` | string | 否 | `"openai"`（默认）或 `"anthropic"`。仅 Anthropic 官方需设为 `"anthropic"` |
| `providers.<name>.models` | string[] | 是 | 可用模型列表，`/model` 切换时从此列表选择 |
| `providers.<name>.visionModels` | string[] | 否 | 支持多模态图片理解的模型子集（必须是 `models` 的子集），默认空数组 |

<details>
<summary>多 Provider 配置示例</summary>

```jsonc
{
  "defaultProvider": "glm",
  "defaultModel": "glm-5",
  "providers": {
    "glm": {
      "apiKey": "your-zhipu-api-key",
      "baseURL": "https://open.bigmodel.cn/api/coding/paas/v4",
      "models": ["glm-5", "glm-4.7"]
    },
    "anthropic": {
      "apiKey": "sk-ant-xxx",
      "protocol": "anthropic",
      "models": ["claude-sonnet-4-20250514"],
      "visionModels": ["claude-sonnet-4-20250514"]
    },
    "deepseek": {
      "apiKey": "sk-xxx",
      "baseURL": "https://api.deepseek.com/v1",
      "models": ["deepseek-chat", "deepseek-reasoner"]
    },
    "openai": {
      "apiKey": "sk-xxx",
      "models": ["gpt-4o", "gpt-4o-mini"],
      "visionModels": ["gpt-4o"]
    },
    "ollama": {
      "apiKey": "ollama",
      "baseURL": "http://localhost:11434/v1",
      "models": ["qwen2.5:7b", "deepseek-r1:14b"]
    }
  }
}
```

</details>

---

## 三种运行模式

### 交互模式（默认）

```bash
ccode                # 进入交互式终端对话
ccode --web          # 交互模式 + Web Dashboard
ccode --resume       # 恢复上一次会话
```

### 管道模式（非交互，适用于脚本 / CI）

```bash
ccode "这段代码有什么问题"                     # 单次问答
cat error.log | ccode "分析这个错误日志"        # stdin 管道输入
ccode -p "生成 API 文档" --json                # JSON 结构化输出
ccode "跑测试并修复" --yes                     # 自动批准工具（CI 场景）
ccode "解释这个函数" --no-tools                # 纯对话，不调用工具
```

| 参数 | 说明 |
|------|------|
| `-p / --prompt` | 指定问题 |
| `-m / --model` | 指定模型 |
| `--provider` | 指定供应商 |
| `--yes / -y` | 自动批准所有工具调用 |
| `--no-tools` | 禁用工具，纯对话 |
| `--json` | 结构化输出（response + usage + cost） |
| `--verbose / -v` | stderr 输出工具执行进度 |

### Web Dashboard 模式（Claude Code 没有的能力）

> CCode 自带完整的 Web Dashboard，让 AI Agent 的工作过程可观测、可管理、可协作。

```bash
ccode --web
```

浏览器打开 `http://localhost:9800`，获得 5 大管理页面：

#### 1. 总览大盘（Overview）

- 6 大核心指标卡片：调用次数、输入/输出/缓存 Token、总费用
- 趋势图表（Token + 费用曲线）、Provider / 模型分布饼图
- 时间范围：当日 / 本周 / 本月 / 自定义日期

#### 2. 实时对话（Chat）

- Web 端直接聊天，Markdown + 代码高亮
- CLI ↔ Web 双向实时同步
- 工具调用可视化（名称、参数、结果、耗时）
- 危险工具权限确认弹窗、用户问卷表单
- 流式输出 + 思考中状态提示

#### 3. 对话历史（Conversations）

- 全量会话列表、消息回放、子 Agent 快照
- 一键恢复对话、搜索过滤

#### 4. 设置管理（Settings）

- Provider 在线配置（apiKey / baseURL / 模型 / Vision 标记）
- 模型拖拽排序、一键连通性测试
- 保存后自动广播到所有 CLI 实例，无需重启
- 计价规则 CRUD（四维价格 + 多币种）
- 插件 & MCP Server 状态管理

#### 5. 系统日志（Logs）

- Agent 运行诊断、系统事件追踪

**架构**：多 CLI 平等连接 → Bridge Server（纯路由器）→ Web SPA，按 sessionId 隔离。

---

## 核心能力

### Agent 引擎

- **多轮自动循环** — LLM → 工具执行 → 下一轮，AsyncGenerator 事件驱动
- **16 个内置工具** — 文件读写/编辑、glob/grep 搜索、bash 执行、子 Agent 派发、任务管理
- **并行工具执行** — 多个 tool_calls 自动并行，安全/危险分类策略
- **子 Agent (SubAgent)** — general / explore / plan 三种类型，`Ctrl+B` 实时查看执行面板
- **上下文管理** — `/compact` 三种压缩策略 + auto-compact

### 多模型运行时切换

运行时 `/model` 一键切换，不重启、不丢上下文：

| Provider | 协议 | 模型示例 |
|----------|------|---------|
| 智谱 GLM | OpenAI 兼容 | GLM-5 / GLM-4.7 |
| Anthropic | Anthropic 原生 | Claude Opus / Sonnet / Haiku 4.x |
| DeepSeek | OpenAI 兼容 | deepseek-chat / deepseek-reasoner |
| OpenAI | OpenAI 兼容 | GPT-4o / GPT-4o-mini |
| Google Gemini | OpenAI 兼容 | gemini-2.5-pro / gemini-2.5-flash |
| Ollama | OpenAI 兼容 | 任意本地模型 |
| **任意服务** | OpenAI 兼容 | 配置 `baseURL` 即可接入 |

### 对话持久化与恢复

- **自动持久化** — 每次对话写入 JSONL 事件链
- **会话恢复** — `ccode --resume` 或 `/resume` 面板恢复历史会话
- **对话分支** — `/fork` 从任意节点创建新分支
- **Web 恢复** — 历史页面一键恢复对话

### Memory / RAG 记忆系统

- **混合检索** — BM25 关键词 + 向量相似度，中文 jieba 分词
- **双层存储** — `~/.ccode/memory/`（全局）+ `<项目>/.ccode/memory/`（项目级）
- **LLM 工具** — `memory_write` / `memory_search` / `memory_delete`，Agent 自动读写
- **命令管理** — `/remember` 查看、搜索、删除、重建索引
- **System Prompt 注入** — 冷启动自动检索相关记忆注入上下文

### Token 计量与计费

- 四维统计：input / output / cache_read / cache_write
- 多币种（USD / CNY），按 provider + model 匹配计价规则
- `/usage` 查看会话/今日/本月统计
- Web Dashboard 趋势图表

---

## 扩展生态

### MCP 协议

动态注册外部工具，支持 4 种传输：stdio / SSE / streamable-http / http

```jsonc
// ~/.ccode/mcp.json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "my-mcp-server"],
      "transport": "stdio"
    }
  }
}
```

### Skills 系统（兼容 Claude Code Skill 生态）

- 四源发现：内置 → 插件 → 用户级(`~/.ccode/skills/`) → 项目级(`<cwd>/.ccode/skills/`)
- **SKILL.md 格式与 Claude Code 完全兼容**，社区 Skill（如 [skills.sh](https://skills.sh/) 275+ Skill）可直接使用
- LLM 自动触发或 `/skills <name>` 手动调用

> 迁移方式：将 Claude Code 的 `~/.claude/skills/` 复制到 `~/.ccode/skills/` 即可

### Runtime Plugin

```
~/.ccode/plugins/<name>/runtime/index.js    # 用户级
<cwd>/.ccode/plugins/<name>/runtime/index.js # 项目级
```

扩展点：注册命令、工具、UI 按钮、状态栏、事件监听、持久化存储。

### Hooks 事件钩子

三层配置（项目 > 用户 > 插件），三类事件：

| 事件 | 时机 | 用途 |
|------|------|------|
| SessionStart | 会话启动 | 注入上下文 |
| PreToolUse | 工具调用前 | 权限控制、参数修改 |
| PostToolUse | 工具执行后 | 日志、后处理 |

---

## Claude Code 兼容性

| 特性 | CCode | Claude Code | 兼容 |
|------|-------|------------|------|
| 指令文件 | CCODE.md | CLAUDE.md | 两者均识别 |
| MCP 配置 | ~/.ccode/mcp.json | ~/.claude.json | 均可读取 |
| SKILL.md 格式 | 相同 | 相同 | 直接使用 |
| 项目设置 | .ccode/settings.local.json | .claude/settings.local.json | 格式兼容 |

---

## 全部指令

| 指令 | 别名 | 说明 |
|------|------|------|
| `/help` | — | 显示所有命令 |
| `/model` | `/m` | 切换模型 |
| `/clear` | — | 清空对话 |
| `/compact` | — | 压缩上下文 |
| `/context` | — | 上下文使用率 |
| `/resume` | — | 恢复历史会话 |
| `/fork` | — | 对话分支 |
| `/usage` | `/cost` | Token 用量统计 |
| `/gc` | `/cleanup` | 清理过期数据 |
| `/skills` | `/skill` | Skills 管理 |
| `/remember` | `/mem` | 记忆管理 |
| `/mcp` | — | MCP 状态 |
| `/bridge` | — | Bridge 管理 |
| `/plugins` | — | 插件列表 |
| `/exit` | `/quit` | 强制退出 |

## 快捷键

| 操作 | 按键 | 备用 |
|------|------|------|
| 提交输入 | Enter | — |
| 换行 | Alt+Enter | Shift+Alt+Enter |
| 光标移动 | ↑ ↓ ← → | — |
| 跳到行首/行尾 | Home / End | Ctrl+A / Ctrl+E |
| 中断流式 | Escape | Ctrl+C |
| 强制退出 | Ctrl+C × 2 | /exit |
| SubAgent 面板 | Ctrl+B | — |

---

## 配置文件一览

| 文件 | 路径 | 用途 |
|------|------|------|
| 主配置 | `~/.ccode/config.json` | Provider / Model / Shell |
| MCP | `~/.ccode/mcp.json` | MCP Server 连接 |
| 指令文件 | CCODE.md / CLAUDE.md（多层级） | System Prompt 注入 |
| 项目权限 | `<cwd>/.ccode/settings.local.json` | 工具白名单 |
| Hooks | `hooks.json`（项目/用户/插件） | 事件钩子 |
| 记忆 | `~/.ccode/memory/` + `<cwd>/.ccode/memory/` | RAG 记忆存储 |
| 调试日志 | `<cwd>/.ccode/debug.log` | Debug 日志 |

## 文档

详细架构与能力文档见 [GitHub docs/](https://github.com/1207575273/CCode/tree/main/docs)

## License

[BSL 1.1](https://github.com/1207575273/CCode/blob/main/LICENSE) — 个人和非商业使用自由，商业使用需授权。
