# CCode

**开源多模型 AI 编程 CLI 助手** — 支持 Claude / OpenAI / GLM / DeepSeek / Ollama，一个终端搞定所有模型。

> **C** = **C**odeYang（作者）· **C**hina（中国开发者出品）· **C**ode Agent

[![License: BSL 1.1](https://img.shields.io/badge/License-BSL%201.1-blue.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/ccode-cli)](https://www.npmjs.com/package/ccode-cli)

```bash
npm install -g ccode-cli
```

---

## 安装与使用

### npm 安装（推荐）

```bash
# 全局安装
npm install -g ccode-cli

# 启动
ccode
```

### npx 临时运行

```bash
npx ccode-cli
```

### 从源码运行

```bash
cd cCli
pnpm install
pnpm dev
```

### 使用示例

```bash
# 交互式对话
ccode

# 单次提问（Pipe 模式）
ccode "帮我看看这个项目的目录结构"

# 恢复上次会话
ccode --resume

# 指定模型
ccode -m glm-5
```

---

## 核心能力

| 能力 | 说明 |
|------|------|
| **多模型切换** | 运行时 `/model` 一键切换，不重启、不丢上下文 |
| **16 个内置工具** | 文件读写、Shell 执行、代码搜索、子 Agent 派发、任务规划 |
| **MCP 协议** | stdio / SSE / streamable-http，动态注册外部工具 |
| **Skills 生态** | 内置 + 项目级 + [skills.sh](https://skills.sh/) 市场一键安装 |
| **上下文管理** | 实时使用率追踪 + `/compact` 三种压缩策略 + auto-compact |
| **对话持久化** | JSONL 会话 + `--resume` 恢复 + `/fork` 分支 |
| **SubAgent** | 后台并行运行 + CLI 悬浮面板（Ctrl+B）实时查看 |
| **Token 计量** | 四维 token 统计 + 多币种计价 + `/usage` |
| **Claude Code 兼容** | CLAUDE.md、.mcp.json、插件目录结构零迁移 |

---

## 配置

首次启动自动创建 `~/.ccode/config.json`：

```jsonc
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-6",
  "providers": {
    "anthropic": {
      "apiKey": "sk-ant-xxxxx",
      "models": ["claude-opus-4-6", "claude-sonnet-4-6"]
    },
    "glm": {
      "apiKey": "your-api-key",
      "baseURL": "https://open.bigmodel.cn/api/coding/paas/v4",
      "models": ["glm-5", "glm-4.7"]
    },
    "openai": {
      "apiKey": "sk-xxxxx",
      "models": ["gpt-4o", "gpt-4o-mini"]
    }
  }
}
```

### 快速上手：以 GLM 为例

本项目日常开发使用 **智谱 GLM-5** 作为基准测试模型。最小化配置：

```jsonc
{
  "defaultProvider": "glm",
  "defaultModel": "glm-5",
  "providers": {
    "glm": {
      "apiKey": "your-zhipu-api-key",
      "baseURL": "https://open.bigmodel.cn/api/coding/paas/v4",
      "models": ["glm-5", "glm-4.7"]
    }
  }
}
```

1. 前往 [智谱开放平台](https://open.bigmodel.cn/) 注册并获取 API Key
2. 将上述配置写入 `~/.ccode/config.json`，替换 `your-zhipu-api-key`
3. 启动 CCode（`pnpm dev` 或 `ccode`），即可使用 GLM-5 进行对话和工具调用

> GLM 走 **OpenAI 兼容协议**，无需声明 `protocol` 字段。运行时输入 `/model glm-4.7` 可切换模型。

> 更多配置说明（MCP、指令文件、插件、Hooks、权限）见 [HISTORY_README.md](./HISTORY_README.md)

---

## 指令

| 指令 | 说明 |
|------|------|
| `/model` | 交互式切换模型 |
| `/compact` | 压缩上下文（支持 `--strategy` 选择策略） |
| `/context` | 查看上下文窗口使用率 |
| `/resume` | 恢复历史会话 |
| `/fork` | 从某条消息分支对话 |
| `/usage` | 查看 Token 用量和费用 |
| `/mcp` | MCP Server 连接状态 |
| `/skills` | 列出可用 Skill |
| `/clear` | 清空当前对话 |
| `/help` | 查看所有指令 |

---

## 支持的模型

| Provider | 模型 | 协议 |
|----------|------|------|
| Anthropic | Claude Opus/Sonnet/Haiku 4.x | Anthropic 原生 |
| OpenAI | GPT-4o / GPT-4o-mini | OpenAI 兼容 |
| 智谱 GLM | GLM-5 / GLM-4.7 | OpenAI 兼容 |
| DeepSeek | deepseek-chat / deepseek-reasoner | OpenAI 兼容 |
| Ollama | 任意本地模型 | OpenAI 兼容 |
| MiniMax | MiniMax-M2.5 | Anthropic 兼容 |

---

## 技术栈

- **CLI**: TypeScript + Ink 5 + React 18
- **Web**: Vite + Tailwind + React Router
- **Agent**: 自研 AgentLoop（AsyncGenerator 事件流）
- **持久化**: JSONL + libsql (SQLite)
- **构建**: tsup (CLI) + Vite (Web)
- **测试**: Vitest · 59 文件 · 453 用例

---

## License

[BSL 1.1](./LICENSE) — 个人和非商业使用自由，商业使用需授权。

---

> 本项目原名 ZCli / ZCode，2026-03-20 更名为 CCode。完整的配置文档、插件系统、Hook 机制、权限管理等详细说明见 [HISTORY_README.md](./HISTORY_README.md)。
