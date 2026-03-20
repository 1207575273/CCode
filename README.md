# CCode

**开源多模型 AI 编程 CLI 助手** — 对标 Claude Code 的交互体验，不绑定单一 LLM 提供商。

> **C** = **C**odeYang（作者）、**C**hina（中国开发者出品）、**C**ode（编程助手）

[![License: BSL 1.1](https://img.shields.io/badge/License-BSL%201.1-blue.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/ccode-cli)](https://www.npmjs.com/package/ccode-cli)

---

## 项目背景

### 改名说明

本项目原名 **ZCli / ZCode**，于 2026 年 3 月更名为 **CCode**。

更名原因：
- 原名 ZCode 与多个已有项目重名，npm 上 `zcli` 也已被占用
- **CCode** 的 **C** 寓意 **C**odeYang（作者英文名）、**C**hina（中国开发者出品）、**C**ode Agent
- npm 包名：`ccode-cli`，安装后命令：`ccode`
- 配置目录从 `~/.zcli/` 迁移至 `~/.ccode/`，指令文件从 `ZCLI.md` 改为 `CCODE.md`

> 如果你之前使用过旧版，只需将 `~/.zcli/` 重命名为 `~/.ccode/` 即可平滑迁移。

### 为什么做这个

Claude Code 是目前最好的 AI 编程 CLI 工具，但它有一个硬约束：**只能用 Claude 模型**。对于需要在不同场景下切换模型的开发者来说，这意味着要在多个工具之间反复切换，丢失上下文和工作流的连贯性。

CCode 的目标是：**让开发者在终端中自由选择 Claude / GPT / Gemini / GLM / DeepSeek / 本地 Ollama 等任意模型，获得一致的 AI 辅助编码体验。** 同时完全兼容 Claude Code 的生态（CLAUDE.md 指令文件、MCP 协议、插件系统）。

### 核心理念

- **多模型自由切换** — 运行时 `/model` 一键切换，不重启、不丢上下文
- **Claude Code 生态兼容** — CLAUDE.md、.mcp.json、插件目录结构完全兼容，已有配置零迁移
- **Agent 能力完整** — 工具调用、并行执行、子 Agent 派发、权限管控、会话持久化
- **可观测** — Token 计量计费、结构化日志、Session JSONL 全量审计
- **Web 能力** — CLI 和浏览器双向实时同步，同一对话两端共享

### 当前状态

CCode 处于活跃开发阶段（v0.0.1），核心 Agent 能力已稳定，日常用于驱动自身的开发（self-hosting）。

### 主要特性

| 特性 | 说明 |
|------|------|
| 多模型支持 | Claude / OpenAI / Gemini / GLM / DeepSeek / Ollama，运行时切换 |
| 内置工具集 | read / write / edit / glob / grep / bash + 子 Agent 派发 |
| MCP 支持 | stdio / SSE / streamable-http，动态注册外部工具 |
| Skills 系统 | 自研 Skill 体系 + 兼容 Claude Code 插件生态（superpowers 等） |
| 对话持久化 | JSONL 会话文件 + --resume 恢复 + /fork 分支 |
| Token 计量 | 四维 token 记录 + 多币种计价 + /usage 实时统计 |
| 指令文件 | CCODE.md / CLAUDE.md 多层级注入，完全兼容 Claude Code |

---

## 目录结构

```
claude_cli_z01/
  docs/       # 需求与设计文档
  cCli/       # 项目代码
    src/       # 核心源码（Agent Loop / Tools / Providers / UI）
    tests/     # 测试
```

---

## 环境要求

| 工具 | 版本 |
|------|------|
| Node.js | >= 20 |
| pnpm | >= 9 |

> 推荐使用 nvm 管理 Node.js 版本：
> ```bash
> nvm install 20
> nvm use 20
> ```

---

## 快速开始

### 1. 安装依赖

```bash
cd cCli
pnpm install
```

### 2. 开发模式启动（推荐）

```bash
pnpm dev
```

直接运行 TypeScript 源码，无需构建，修改代码后重启即可生效。

### 3. 构建后运行

```bash
pnpm build
node dist/bin/ccode.js
```

---

## 界面操作

| 操作 | 说明 |
|------|------|
| 直接打字 | 在底部输入框输入消息 |
| `Enter` | 发送消息 |
| `Escape` | 中断当前回复 |
| `Ctrl+C` | 双击退出 |

### 斜杠指令

| 指令 | 说明 |
|------|------|
| `/help` | 查看所有指令 |
| `/model` | 交互式切换模型 |
| `/model <name>` | 直接切换到指定模型 |
| `/clear` | 清空当前对话 |
| `/resume` | 恢复历史会话 |
| `/fork` | 从某条消息分支对话 |
| `/usage` | 查看 Token 用量和费用 |
| `/mcp` | 查看 MCP Server 连接状态 |
| `/skills` | 列出可用 Skill |
| `/gc` | 清理过期会话和用量记录 |
| `/gc --days 0` | 清理全部会话（保留 0 天） |
| `/gc --dry-run` | 预览将清理的数据量 |

---

## 其他命令

```bash
# 运行测试
pnpm test

# 监听模式测试（开发时）
pnpm test:watch

# TypeScript 类型检查
pnpm typecheck

# 构建
pnpm build
```

---

## 配置

CCode 的配置文件位于 `~/.ccode/` 目录下，首次启动时自动创建。

### config.json — 主配置

路径：`~/.ccode/config.json`

```jsonc
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-6",
  "providers": {
    // Anthropic 官方
    "anthropic": {
      "apiKey": "sk-ant-xxxxx",
      "models": ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]
    },
    // OpenAI 兼容协议（GLM、DeepSeek、Ollama 等）
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

**字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `defaultProvider` | `string` | 启动时默认使用的 Provider 名称 |
| `defaultModel` | `string` | 启动时默认使用的模型名称 |
| `providers.<name>.apiKey` | `string` | Provider 的 API Key |
| `providers.<name>.baseURL` | `string?` | 自定义 API 端点 |
| `providers.<name>.protocol` | `'anthropic' \| 'openai'?` | 协议类型（见下方说明） |
| `providers.<name>.models` | `string[]` | 该 Provider 可用的模型列表 |

> 运行时可通过 `/model` 指令或 `/model <模型名>` 快速切换模型。

### 快速上手：以 GLM 为例

本项目日常开发使用 **智谱 GLM-5** 驱动。以下是一个最小化的 GLM 配置示例，可直接复制使用：

```jsonc
{
  "defaultProvider": "glm",
  "defaultModel": "glm-5",
  "providers": {
    "glm": {
      "apiKey": "your-zhipu-api-key",        // 智谱开放平台 API Key
      "baseURL": "https://open.bigmodel.cn/api/coding/paas/v4",
      "models": ["glm-5", "glm-4.7"]
    }
  }
}
```

**步骤：**

1. 前往 [智谱开放平台](https://open.bigmodel.cn/) 注册并获取 API Key
2. 将上述配置写入 `~/.ccode/config.json`，替换 `your-zhipu-api-key` 为你的真实 Key
3. 启动 CCode（`pnpm dev`），即可使用 GLM-5 进行对话和 Agent 工具调用

> GLM 走 **OpenAI 兼容协议**，无需额外声明 `protocol` 字段。如需切换模型，在对话中输入 `/model glm-4.7` 即可。

### 接入 Anthropic 兼容协议的第三方 Provider

CCode 支持两种 LLM 协议：**Anthropic 原生协议**和 **OpenAI 兼容协议**。

- 名为 `anthropic` 的 provider 自动走 Anthropic 原生协议
- 其他 provider 默认走 OpenAI 兼容协议
- 通过 `protocol` 字段可以显式指定协议类型

如果你使用的第三方 API 兼容 Anthropic Messages API（如 MiniMax），需要声明 `"protocol": "anthropic"`：

```jsonc
{
  "defaultProvider": "minimax",
  "defaultModel": "MiniMax-M2.5",
  "providers": {
    "minimax": {
      "apiKey": "your-minimax-api-key",
      "baseURL": "https://api.minimaxi.com/anthropic",
      "protocol": "anthropic",
      "models": ["MiniMax-M2.5", "MiniMax-M2.5-highspeed"]
    }
  }
}
```

更多示例：

```jsonc
{
  "providers": {
    // DeepSeek — OpenAI 兼容，不需要写 protocol
    "deepseek": {
      "apiKey": "sk-xxx",
      "baseURL": "https://api.deepseek.com/v1",
      "models": ["deepseek-chat", "deepseek-reasoner"]
    },
    // 某个兼容 Anthropic API 的代理
    "my-proxy": {
      "apiKey": "proxy-key",
      "baseURL": "https://my-proxy.example.com/anthropic/v1",
      "protocol": "anthropic",
      "models": ["claude-sonnet-4-6"]
    }
  }
}
```

### .mcp.json — MCP Server 配置

CCode 支持 [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) 协议，可连接外部工具服务器扩展 Agent 能力。

**配置文件搜索路径（按优先级从高到低）：**

| 优先级 | 路径 | 说明 |
|--------|------|------|
| 1（最高） | `~/.ccode/.mcp.json` | CCode 专属配置 |
| 2 | `~/.claude.json` | Claude Code 用户配置（兼容） |
| 3 | `~/.mcp.json` | 通用 MCP 全局配置 |

同名 Server 出现在多个文件时，高优先级覆盖低优先级。

路径：`~/.ccode/.mcp.json`

```jsonc
{
  "mcpServers": {
    // Stdio 模式：启动本地子进程
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"],
      "env": {
        "NODE_ENV": "production"
      }
    },
    // Streamable HTTP 模式：连接远程服务
    "deepwiki": {
      "type": "streamable-http",
      "url": "https://mcp.deepwiki.com/mcp"
    },
    // SSE 模式
    "my-sse-server": {
      "type": "sse",
      "url": "http://localhost:3001/sse"
    },
    // HTTP 模式（兼容 .claude.json 格式，含自定义请求头）
    "remote-api": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer your-token"
      }
    }
  }
}
```

**Server 配置字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `command` | `string?` | Stdio 模式：要执行的命令 |
| `args` | `string[]?` | Stdio 模式：命令参数 |
| `env` | `Record<string, string>?` | Stdio 模式：附加环境变量 |
| `type` | `'stdio' \| 'sse' \| 'streamable-http' \| 'http'?` | 传输类型（有 `command` 时默认 stdio，有 `url` 时默认 streamable-http） |
| `url` | `string?` | 远程模式：服务端 URL |
| `headers` | `Record<string, string>?` | HTTP/Streamable HTTP 模式：自定义请求头 |

> 运行时可通过 `/mcp` 指令查看所有 Server 的连接状态和工具列表。

---

## 指令文件（CCODE.md / CLAUDE.md）

CCode 支持通过指令文件向 LLM 注入自定义规范和偏好，**完全兼容 Claude Code 的 CLAUDE.md 生态**。

### 工作原理

启动时自动扫描以下位置的指令文件，内容注入 system prompt，LLM 在每次对话中自动遵循。

**每个层级优先查找 `CCODE.md`，没有则 fallback 到 `CLAUDE.md`**（同层只取一个）。

### 查找顺序

| 优先级 | 路径 | 说明 |
|--------|------|------|
| 1 | `~/.ccode/CCODE.md` → `~/.claude/CLAUDE.md` | 全局用户级 — 你的通用编码习惯和偏好 |
| 2 | `<git-root>/CCODE.md` → `<git-root>/CLAUDE.md` | 项目根 — 团队共享的项目规范 |
| 3 | `<git-root>/.ccode/CCODE.md` → `<git-root>/.claude/CLAUDE.md` | 项目配置目录 |
| 4 | `<cwd>/CCODE.md` → `<cwd>/CLAUDE.md` | 当前工作目录（仅当 cwd ≠ git-root 时） |

所有找到的文件内容会按层级顺序拼接，一起注入 system prompt。

### 兼容 Claude Code

如果你已经在使用 Claude Code 并配置了 `CLAUDE.md`，**无需任何改动**，CCode 会自动加载：

- `~/.claude/CLAUDE.md` — 你的全局 Claude Code 指令会被 CCode 直接复用
- `<项目>/CLAUDE.md` — 项目级 Claude Code 指令同样生效

当你想为 CCode 定制不同于 Claude Code 的指令时，在同层级放一个 `CCODE.md` 即可覆盖 `CLAUDE.md`。

### 示例

**全局指令**（`~/.ccode/CCODE.md` 或 `~/.claude/CLAUDE.md`）：

```markdown
# 编码规范

- 永远使用中文与我对话
- Git 提交信息遵循 Conventional Commits 格式
- 优先使用 TypeScript，strict 模式
- 异常处理：禁止空 catch 块
```

**项目级指令**（`<项目根>/CCODE.md` 或 `<项目根>/CLAUDE.md`）：

```markdown
# 项目约定

- 这是一个 React + Vite 项目
- 组件放在 src/components/，hooks 放在 src/hooks/
- 使用 Tailwind CSS，不写内联样式
- 测试框架：Vitest + Testing Library
```

### 注意事项

- 指令文件在会话启动时加载，**会话期间修改不会自动生效**，需重启对话
- 空文件或读取失败的文件会被静默跳过，不影响启动
- REPL 模式和 Pipe 模式（`ccode "问题"`）均会加载指令文件

---

## 插件系统

CCode 支持通过插件包扩展 Skill 能力，兼容 Claude Code 的插件生态（如 [superpowers](https://github.com/obra/superpowers)）。

### 安装插件

将插件目录复制到 `~/.ccode/plugins/` 下即可（目录名即为插件名）：

```bash
# 方式一：从 Git 克隆
git clone https://github.com/obra/superpowers.git ~/.ccode/plugins/superpowers

# 方式二：直接复制已有目录
# Linux / macOS
cp -r /path/to/superpowers ~/.ccode/plugins/superpowers

# Windows
xcopy /E /I "D:\path\to\superpowers" "%USERPROFILE%\.ccode\plugins\superpowers"
```

> 如果你已安装了 Claude Code 的 superpowers 插件，可以直接从缓存复制：
> ```bash
> # Windows
> xcopy /E /I "%USERPROFILE%\.claude\plugins\cache\claude-plugins-official\superpowers\5.0.2" "%USERPROFILE%\.ccode\plugins\superpowers"
>
> # Linux / macOS
> cp -r ~/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.2 ~/.ccode/plugins/superpowers
> ```

项目级插件放在 `<项目根>/.ccode/plugins/` 下。

### 插件目录结构

```
~/.ccode/plugins/
  └── superpowers/              ← 插件包名
      ├── skills/               ← skills 目录（必需）
      │   ├── brainstorming/
      │   │   ├── SKILL.md
      │   │   └── visual-companion.md  ← 支撑文件
      │   ├── writing-plans/
      │   │   └── SKILL.md
      │   └── ...
      ├── hooks/                ← hooks 目录（可选）
      │   └── hooks.json
      └── plugin.json           ← 插件清单（可选）
```

### 命名空间

插件内的 Skill 自动添加 `<插件名>:` 前缀，避免与内置 Skill 冲突：

| 来源 | 注册名示例 |
|------|-----------|
| 内置 Skill | `commit` |
| 用户自定义 Skill | `my-tool` |
| 插件 Skill | `superpowers:brainstorming` |

**优先级**：项目级 > 用户级 > 插件 > 内置

### 以 superpowers 为例

```bash
# 1. 安装：从 Claude Code 缓存复制（如果已安装 Claude Code superpowers 插件）
# Windows
xcopy /E /I "%USERPROFILE%\.claude\plugins\cache\claude-plugins-official\superpowers\5.0.2" "%USERPROFILE%\.ccode\plugins\superpowers"

# 或者从 Git 克隆
git clone https://github.com/obra/superpowers.git ~/.ccode/plugins/superpowers

# 2. 启动 CCode，自动发现插件中的所有 Skills
pnpm dev
```

启动后 system prompt 中会包含 `superpowers:brainstorming`、`superpowers:writing-plans` 等 Skill 列表，LLM 会自动按需调用。

---

## Hook 系统

CCode 支持事件钩子，可在会话启动、工具执行前后注入自定义逻辑。

### 事件类型

| 事件 | 触发时机 | 典型用途 |
|------|----------|----------|
| `SessionStart` | 会话启动 | 插件启动注入、环境检查 |
| `PreToolUse` | 工具执行前 | 权限拦截、参数校验 |
| `PostToolUse` | 工具执行后 | 结果审计、通知 |

### 配置文件

Hook 配置来自三层来源（叠加执行，不覆盖）：

| 来源 | 路径 |
|------|------|
| 插件包 | `~/.ccode/plugins/<name>/hooks/hooks.json` |
| 项目级 | `<项目根>/.ccode/hooks.json` |
| 用户级 | `~/.ccode/hooks.json` |

### hooks.json 格式

```jsonc
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "echo '{\"additionalContext\": \"hello from hook\"}'",
            "timeout": 10000
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "bash",
        "hooks": [
          {
            "type": "command",
            "command": "echo '{\"decision\": \"allow\"}'",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```

- `matcher`：正则表达式，匹配触发条件（SessionStart 匹配子类型，PreToolUse/PostToolUse 匹配工具名）
- `timeout`：超时毫秒数，默认 10000
- Hook 通过 stdout 输出 JSON 返回结果，超时或失败静默跳过

> 插件包自带的 `hooks/hooks.json`（如 superpowers 的 SessionStart hook）会被自动发现和执行，无需手动配置。

---

## 项目级权限配置

CCode 支持项目级工具权限白名单，白名单内的工具执行时无需确认，不在白名单内的仍遵循原有的询问确认机制。

### 配置文件

路径：`<项目根目录>/.ccode/settings.local.json`（首次启动时自动创建空模板）

```jsonc
{
  "permissions": {
    "allow": [
      "Bash(*)",           // bash 命令免确认
      "Read(*)",           // 读文件免确认
      "Write(*)",          // 写文件免确认
      "Edit(*)",           // 编辑文件免确认
      "Glob(*)",           // 文件搜索免确认
      "Grep(*)",           // 内容搜索免确认
      "mcp__*"             // 所有 MCP 工具免确认
    ]
  }
}
```

### 规则格式

| 格式 | 示例 | 说明 |
|------|------|------|
| `FriendlyName(*)` | `Bash(*)`, `Read(*)` | 友好名匹配，自动解析为实际工具名 |
| `前缀通配符` | `mcp__*` | 匹配所有以该前缀开头的工具 |
| `精确工具名` | `mcp__context7__query-docs` | 精确匹配特定工具 |
| `内部工具名` | `bash`, `read_file` | 直接使用内部注册的工具名 |

> 默认模板为 `"allow": []`（空），即所有危险工具仍需确认。按需添加规则即可。

> 建议将 `.ccode/settings.local.json` 加入 `.gitignore`，避免团队成员间权限配置冲突。

---

## 技术栈

- **运行时**：Node.js 20 + TypeScript 5（strict 模式）
- **终端 UI**：Ink 5 + React 18
- **LLM 调用层**：`@anthropic-ai/sdk`（Anthropic 原生协议）+ `@langchain/openai`（OpenAI 兼容协议）
- **Agent Loop**：完全自研（不使用 LangGraph），AsyncGenerator 事件流架构
- **持久化**：JSONL 会话文件 + libsql（SQLite）
- **包管理**：pnpm
- **构建**：tsup
- **测试**：Vitest
