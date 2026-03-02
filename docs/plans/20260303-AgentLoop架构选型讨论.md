# Agent Loop 架构选型讨论

> 日期: 2026-03-03 | 状态: 待决策

---

## 背景

ZCli 的 Agent Loop 是整个产品的核心引擎。在 LLM 调用层需要做一个关键决策：

**核心诉求**：只要支持 OpenAI 兼容协议的供应商都能接入，避免对任何单一模型 SDK 的依赖。

**待决策问题**：LLM 调用层是用纯原生 HTTP、LangChain/LangGraph TS，还是轻量 SDK（如 Vercel AI SDK）？

---

## 方案对比

### 方案 A：纯 OpenAI 兼容协议（原生 HTTP）

自研 HTTP Client，只对接 `/v1/chat/completions` 协议。

```typescript
interface ProviderConfig {
  baseURL: string       // 唯一需要变的东西
  apiKey: string
  model: string
}

// Anthropic:  https://api.anthropic.com/v1/
// OpenAI:     https://api.openai.com/v1/
// Gemini:     https://generativelanguage.googleapis.com/v1beta/openai/
// Ollama:     http://localhost:11434/v1/
// vLLM:       http://localhost:8000/v1/
// 任意兼容服务: https://your-proxy.com/v1/
```

**需要自己实现的部分：**
- SSE (Server-Sent Events) 流式响应解析
- tool_use 请求/响应格式组装（各家有细微差异）
- 错误处理、重试、超时控制
- Token 数提取（从响应 usage 字段）
- 请求并发控制、abort 信号

**优点：**
- 零外部依赖，最大自由度
- 完全掌控每一个字节的行为
- 不受任何第三方库版本变更影响

**缺点：**
- 工作量大，SSE 解析 + tool calling 协议处理有不少边界情况
- 各家 OpenAI 兼容实现的细微差异需要逐个踩坑
- Anthropic 原生高级特性（extended thinking、cache control、citations）在 OpenAI 兼容接口中不一定支持

**适合场景**：团队有丰富的 HTTP/流式协议经验，对依赖洁癖极强

---

### 方案 B：LangChain / LangGraph TS

用 `@langchain/core` 做 LLM 抽象，`@langchain/langgraph` 做 Agent 状态机。

```typescript
import { ChatOpenAI } from "@langchain/openai"
import { ChatAnthropic } from "@langchain/anthropic"
import { StateGraph, MessagesAnnotation } from "@langchain/langgraph"

const model = new ChatOpenAI({
  configuration: { baseURL: "https://your-proxy.com/v1/" },
  modelName: "claude-opus-4-6",
})

const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", callModel)
  .addNode("tools", toolNode)
  .addEdge("__start__", "agent")
  .addConditionalEdges("agent", shouldContinue)
  .compile()
```

**优点：**
- 多模型抽象开箱即用（ChatOpenAI、ChatAnthropic、ChatGoogleGenerativeAI ...）
- Agent 状态机、tool binding、streaming 都有现成方案
- 社区庞大，遇到问题容易搜到方案
- LangGraph 的 checkpoint 机制可以辅助会话恢复

**缺点：**
- **依赖重** — node_modules 膨胀严重，CLI 冷启动速度受影响
- **抽象泄漏** — 调试穿透 LangChain 抽象层极其痛苦，报错看到的是框架堆栈
- **版本动荡** — LangChain JS 的 breaking change 频率高，持续跟版本是长期成本
- **过度设计** — ZCli 做的是 CLI 不是 RAG pipeline，大量 LangChain 能力完全用不上
- **失去核心控制** — Agent Loop 是 ZCli 最重要的差异化能力，交给框架意味着丧失对核心逻辑的掌控

**适合场景**：快速原型、团队熟悉 LangChain 生态、不追求极致体验

---

### 方案 C：Vercel AI SDK（推荐）

用 `ai` 核心包 + `@ai-sdk/openai`（OpenAI 兼容协议）。

```typescript
import { generateText, streamText, tool } from "ai"
import { createOpenAI } from "@ai-sdk/openai"

// 任何 OpenAI 兼容服务，只需换 baseURL
const provider = createOpenAI({
  baseURL: "https://api.anthropic.com/v1/",
  apiKey: process.env.ANTHROPIC_API_KEY,
})

const result = streamText({
  model: provider("claude-opus-4-6"),
  messages,
  tools: {
    readFile: tool({
      description: "Read file contents",
      parameters: z.object({ path: z.string() }),
      execute: async ({ path }) => fs.readFile(path, "utf-8"),
    }),
  },
  maxSteps: 10,
})

// 流式消费
for await (const chunk of result.textStream) {
  process.stdout.write(chunk)
}
```

**Vercel AI SDK 是什么：**
- 一个对 LLM API 调用的**薄 TypeScript 封装**
- 核心只做三件事：发请求、解析流式响应、处理 tool calling 协议
- 不是框架（不管你的 Agent 怎么编排），只是一个调用层工具

**优点：**
- **轻量** — 核心包很小，远不像 LangChain 那样带一堆用不上的东西
- **OpenAI 协议优先** — `@ai-sdk/openai` 本身就是 OpenAI 兼容协议封装，换 baseURL 接新供应商
- **流式原生** — SSE 解析、tool calling 循环、abort 控制都已处理好
- **TypeScript 原生** — 类型安全，和 ZCli 技术栈完全一致
- **Agent Loop 自主控制** — 它只管 LLM 调用，编排逻辑完全自己写
- **逃生门** — 足够薄以至于随时可以替换，不像 LangChain 深度绑定
- **可选原生 Provider** — 需要独有特性时，`@ai-sdk/anthropic` / `@ai-sdk/google` 可以单独引入

**缺点：**
- 依赖 Vercel 团队的维护节奏（不过到目前为止非常稳定）
- Anthropic 独有高级特性需要额外引入 `@ai-sdk/anthropic`

**适合场景**：追求效率和可控性的平衡，不想重复造轮子也不想被框架绑架

---

## 推荐架构：方案 C 为主 + 方案 A 为底

```
┌─────────────────────────────────────────────────────┐
│              Agent Loop (完全自研)                    │
│                                                      │
│  消息管理 → 轮次控制 → 工具编排 → 权限检查           │
│  上下文压缩 → 并行工具调用 → 会话恢复               │
│                                                      │
│  这一层是 ZCli 的灵魂，不交给任何框架                │
├─────────────────────────────────────────────────────┤
│              ZCli LLMProvider 接口 (自研薄抽象)      │
│                                                      │
│  统一接口定义，不暴露底层 SDK 类型                    │
│  将来换掉 AI SDK 只改这一层                          │
├─────────────────────────────────────────────────────┤
│              LLM 调用实现                             │
│                                                      │
│  ┌─────────────────────────────────────────────┐    │
│  │  默认: @ai-sdk/openai (OpenAI 兼容协议)     │    │
│  │  只需 baseURL + apiKey 接入任意供应商        │    │
│  │  覆盖 90% 场景                               │    │
│  ├─────────────────────────────────────────────┤    │
│  │  可选: @ai-sdk/anthropic                     │    │
│  │  Anthropic 独有: extended thinking,          │    │
│  │  cache control, citations                    │    │
│  ├─────────────────────────────────────────────┤    │
│  │  可选: @ai-sdk/google                        │    │
│  │  Google 独有: grounding, code execution      │    │
│  ├─────────────────────────────────────────────┤    │
│  │  逃生口: Raw HTTP fetch                      │    │
│  │  完全自定义场景，绕过所有 SDK                 │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

### 关键设计原则

**1. Agent Loop 完全自研**

这是 ZCli 的核心竞争力，不可外包给框架。自己控制：
- 消息队列管理（system prompt + skills + history + user input 的组装）
- 轮次控制（maxSteps、超时、中断恢复）
- 工具编排（并行调用、降级链、权限确认）
- 上下文窗口管理（token 计数、自动压缩/摘要）

**2. LLM 调用层可替换**

自定义 `LLMProvider` 接口包一层，不让 AI SDK 的类型泄漏到上层：

```typescript
// src/providers/provider.ts — ZCli 自己的接口定义
interface LLMProvider {
  readonly name: string
  readonly protocol: "openai-compat" | "native"

  chat(request: ChatRequest): AsyncIterable<ChatChunk>
  countTokens(messages: Message[]): Promise<number>
}

interface ChatRequest {
  model: string
  messages: Message[]
  tools?: ToolDefinition[]
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

interface ChatChunk {
  type: "text" | "tool_call" | "usage" | "done"
  // ... 统一的响应结构
}
```

底层用 Vercel AI SDK 实现，但上层（Agent Loop）只看到 `LLMProvider` 接口，不知道底下是什么。

**3. OpenAI 兼容协议为主通道**

90% 的供应商通过 `@ai-sdk/openai` + 不同 baseURL 接入，用户加一个新供应商只需改配置：

```jsonc
// ~/.zcli/config.json
{
  "providers": {
    "anthropic": {
      "baseURL": "https://api.anthropic.com/v1/",
      "apiKey": "sk-ant-xxx",
      "protocol": "openai-compat",
      "models": ["claude-opus-4-6", "claude-sonnet-4-6"]
    },
    "openai": {
      "baseURL": "https://api.openai.com/v1/",
      "apiKey": "sk-xxx",
      "models": ["gpt-4o", "o3-mini"]
    },
    "my-proxy": {
      "baseURL": "https://my-proxy.com/v1/",
      "apiKey": "xxx",
      "models": ["claude-opus-4-6", "deepseek-r1"]
    },
    "ollama": {
      "baseURL": "http://localhost:11434/v1/",
      "apiKey": "ollama",
      "models": ["llama3", "codestral"]
    }
  },
  "defaultModel": "anthropic/claude-opus-4-6"
}
```

零代码改动即可接入新的供应商。

**4. 保留原生 Provider 逃生口**

某些供应商有 OpenAI 兼容协议不支持的独有能力：

| 供应商 | 独有特性 | 解决方式 |
|--------|----------|----------|
| Anthropic | extended thinking, cache control, citations | `@ai-sdk/anthropic` 原生 Provider |
| Google | grounding, code execution | `@ai-sdk/google` 原生 Provider |
| 其他 | 未知的自定义协议 | Raw HTTP fetch 逃生口 |

配置中通过 `protocol` 字段区分：
- `"openai-compat"` → 走 `@ai-sdk/openai` (默认)
- `"native-anthropic"` → 走 `@ai-sdk/anthropic`
- `"native-google"` → 走 `@ai-sdk/google`
- `"custom"` → 走用户自定义的 HTTP 适配

---

## 三方案对比总结

| 维度 | A. 纯原生 HTTP | B. LangChain/LangGraph | C. Vercel AI SDK |
|------|---------------|----------------------|-----------------|
| 依赖量 | 零 | 重 (10+ 包) | 轻 (2-3 包) |
| 开发效率 | 低 (全部自研) | 高 (开箱即用) | 中高 (调用层省心) |
| 可控性 | 最高 | 最低 | 高 |
| CLI 启动速度 | 最快 | 最慢 | 快 |
| 调试体验 | 好 (直接看 HTTP) | 差 (框架堆栈) | 好 (薄抽象) |
| 替换成本 | 无 | 极高 (深度绑定) | 低 (只改一层) |
| 版本维护 | 无 | 高 (频繁 breaking) | 低 (API 稳定) |
| 多模型接入 | 手动磨平差异 | 框架处理 | SDK 处理 |
| 高级特性支持 | 需自研 | 部分支持 | 可选原生 Provider |
| 社区生态 | 无 | 大 | 中等偏上 |

---

## 待决策

- [ ] 确认最终方案选择（A / B / C / 其他）
- [ ] 如选方案 C，确认是否引入原生 Provider（@ai-sdk/anthropic 等）还是全部走 OpenAI 兼容
- [ ] Agent Loop 的轮次控制上限策略（固定 maxSteps？动态调整？用户可配置？）
- [ ] 上下文压缩策略（达到 token 上限时：摘要压缩 / 滑动窗口 / 两者结合）
