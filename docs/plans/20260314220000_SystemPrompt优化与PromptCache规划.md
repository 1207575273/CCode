# System Prompt 优化与 Prompt Cache 规划

> 日期: 2026-03-14
> 状态: 待实施
> 触发: 审查 session 日志发现 CLAUDE.md 每次 LLM 调用全量注入，缺少缓存标记

## 一、现状分析

### 1.1 数据流

```
CLAUDE.md (7554 chars ≈ 2000 tokens)
  ↓ instructions-loader.ts — 启动时加载，<instructions> 标签包裹
  ↓ bootstrap.ts — buildSystemPrompt() 拼接 instructions + skills + hookContext
  ↓ cachedSystemPrompt (10630 chars，构建一次，全程复用引用)
  ↓ agent-loop.ts — 每次 #callLLM() 透传给 provider
  ↓ provider.chat() — 发送给 LLM API
```

### 1.2 实测数据（session 日志审查）

| 指标 | 数值 |
|------|------|
| 单次 systemPrompt 大小 | 10630 chars ≈ 2800 tokens |
| 其中 CLAUDE.md 占比 | 7554 chars (71%) |
| 单会话 LLM 调用次数 | 14 次 |
| systemPrompt 是否每次相同 | ✅ 完全相同 |
| systemPrompt 重复发送总量 | ~148K chars ≈ ~39000 tokens |

### 1.3 当前问题

**应用层做对了** — `cachedSystemPrompt` 只构建一次，不重复拼接。

**Provider 层缺失优化：**

| Provider | 问题 |
|----------|------|
| **Anthropic** (`anthropic.ts:130`) | `system: systemPrompt` 传纯字符串，没有使用 `cache_control: { type: "ephemeral" }` 结构化标记 |
| **OpenAI-compat** (`openai-compat.ts:42-43`) | 作为普通 system message 插入 messages 首位，无任何缓存机制 |
| **GLM 等国产模型** | 通过 OpenAI-compat 走，每次调用全量处理 ~2800 tokens，无缓存 |

## 二、Anthropic Prompt Cache 机制

### 2.1 原理

Anthropic API 支持对 system prompt 分段标记 `cache_control`，被标记的内容块在多次调用间复用缓存：

```typescript
// 当前写法 — 纯字符串，cache 命中靠运气
system: "完整的 system prompt 文本..."

// 优化写法 — 结构化分段 + 显式缓存标记
system: [
  {
    type: 'text',
    text: '静态指令内容（CLAUDE.md + Skills）',
    cache_control: { type: 'ephemeral' }  // 标记为可缓存
  },
  {
    type: 'text',
    text: '动态内容（hook context 等）'
    // 不标记，每次重新处理
  }
]
```

### 2.2 费用影响

| 计费维度 | 无 cache | 有 cache | 节省 |
|----------|---------|---------|------|
| 首次调用 | input 价格 | cache_write 价格 (1.25x) | 略贵 |
| 后续调用 | input 价格 | cache_read 价格 (0.1x) | **90%** |
| 14 次调用场景 | 14 × 2800 = 39200 tokens (input) | 1 × 2800 (write) + 13 × 2800 (read) | ~87% |

以 claude-opus-4 为例：
- 无 cache: 39200 × $15/M = $0.588
- 有 cache: 2800 × $18.75/M + 36400 × $1.50/M = $0.107
- **单会话节省 $0.48，长会话（50+ 轮）节省更显著**

## 三、优化方案

### 3.1 ChatRequest 接口升级

```typescript
// src/providers/provider.ts

/** System prompt 内容块 */
interface SystemPromptPart {
  text: string
  /** 标记为可缓存（Provider 按自身能力决定是否启用） */
  cacheable?: boolean
}

interface ChatRequest {
  model: string
  messages: Message[]
  tools?: ToolDefinition[]
  /** 支持字符串（向后兼容）或结构化分段 */
  systemPrompt?: string | SystemPromptPart[]
  // ...
}
```

### 3.2 System Prompt 分段策略

```
systemPrompt: [
  { text: instructionsPrompt,  cacheable: true  },  // CLAUDE.md — 会话内不变
  { text: skillsPrompt,        cacheable: true  },  // Skills 列表 — 会话内不变
  { text: hookContext,         cacheable: false },  // Hook 注入 — 可能变化
]
```

### 3.3 各 Provider 适配

#### Anthropic (`anthropic.ts`)

```typescript
// 将 SystemPromptPart[] 转为 Anthropic system 格式
const system = systemPromptParts.map(part => ({
  type: 'text' as const,
  text: part.text,
  ...(part.cacheable ? { cache_control: { type: 'ephemeral' as const } } : {}),
}))
```

#### OpenAI-compat (`openai-compat.ts`)

OpenAI 兼容协议不支持 system prompt 缓存，直接拼接为单条 system message：

```typescript
const systemText = systemPromptParts.map(p => p.text).join('\n\n')
```

**可选进阶**：对不支持缓存的 provider，按优先级裁剪 system prompt（保留核心指令，省略详细规范），减少每次调用的 token 数。

### 3.4 bootstrap 层适配

```typescript
// bootstrap.ts — buildSystemPrompt 改为输出 SystemPromptPart[]
export function buildSystemPrompt(hookContext: string): void {
  if (cachedSystemPrompt !== undefined) return

  const parts: SystemPromptPart[] = []

  const instructionsPrompt = getInstructionsPrompt()
  if (instructionsPrompt) {
    parts.push({ text: instructionsPrompt, cacheable: true })
  }

  const skillsPrompt = getSkillsSystemPrompt()
  if (skillsPrompt) {
    parts.push({ text: skillsPrompt, cacheable: true })
  }

  if (hookContext) {
    parts.push({ text: hookContext, cacheable: false })
  }

  cachedSystemPrompt = parts.length > 0 ? parts : undefined
}
```

## 四、改动范围评估

| 文件 | 改动 | 复杂度 |
|------|------|--------|
| `src/providers/provider.ts` | `systemPrompt` 类型升级为 `string \| SystemPromptPart[]` | 低 |
| `src/providers/anthropic.ts` | system 参数从字符串改为 `TextBlockParam[]` | 中 |
| `src/providers/openai-compat.ts` | 兼容处理：`SystemPromptPart[]` → 拼接字符串 | 低 |
| `src/core/bootstrap.ts` | `cachedSystemPrompt` 类型改为 `SystemPromptPart[]` | 低 |
| `src/core/agent-loop.ts` | 透传类型变更 | 低 |
| `src/core/pipe-runner.ts` | 同上 | 低 |
| `src/observability/session-logger.ts` | 日志记录适配 | 低 |
| 测试 | agent-loop / provider 相关测试适配 | 中 |

**预估工作量：2-3 小时**

## 五、后续可选优化

### 5.1 按 Provider 能力裁剪 system prompt

对不支持 prompt cache 的模型（GLM、DeepSeek 等），可以：
- 只保留核心编码规范（去掉 TDD、curl 测试等详细章节）
- 按当前任务语言只注入相关领域规范（Java/Python/前端）
- 将详细规范从 system prompt 移到首条 user message 的 context 中

### 5.2 动态 system prompt（按上下文裁剪）

根据当前对话检测到的语言/框架，动态组装 system prompt：
- 检测到 `.java` 文件 → 注入 Java 领域规范
- 检测到 `.tsx` 文件 → 注入前端领域规范
- 通用原则始终保留

这需要 `cachedSystemPrompt` 从"构建一次"变为"按上下文缓存多份"，架构改动较大，作为远期方向。

### 5.3 Token 计量增强

在 TokenMeter 中区分 `cache_read` 和 `cache_write`，让用户能看到 prompt cache 的实际节省效果。当前 `usage_logs` 已有 `cache_read` / `cache_write` 字段，但 Anthropic provider 可能没正确回传这些值，需要验证。

## 六、优先级建议

| 优先级 | 优化项 | 理由 |
|--------|--------|------|
| **P0** | Anthropic cache_control | 直接省钱，改动小，收益确定 |
| **P1** | ChatRequest 接口升级 | 为所有 provider 铺路，架构性改进 |
| **P2** | 按 Provider 裁剪 system prompt | GLM 等模型受益，但需要维护裁剪规则 |
| **P3** | 动态 system prompt | 远期方向，当前 CLAUDE.md 体量还可控 |
