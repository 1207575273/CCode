# ContextTracker 子 Agent 覆盖问题修复

## 一、问题背景

CCode 的上下文窗口追踪由 `contextTracker` 全局单例负责（`src/core/context-tracker.ts`），核心职责：

1. **状态栏展示** — `Ctx 65%` 告诉用户当前上下文消耗比例
2. **`/context` 命令** — 展示详细的窗口使用情况（Used / Available / Level）
3. **Auto-Compact 触发** — 当使用率 >= 95% 时自动压缩历史，防止上下文溢出

数据来源：每次 LLM 调用返回的 `inputTokens`（API 精确值），在 `AgentLoop.#callLLM()` 结束后写入。

## 二、问题描述

### 现象

派发子 Agent 后，状态栏的 `Ctx %` 从正常值（如 65%）骤降到极低值（如 3%），且 `/context` 显示的 Used tokens 明显不符合主对话的实际消耗。

### 根因

`contextTracker` 是**模块级全局单例**，而子 Agent 也创建独立的 `AgentLoop` 实例。问题链路：

```
主 Agent LLM 调用 → contextTracker.update(50000)  // 正确：主 Agent 已用 50K tokens
  ↓
派发子 Agent → new AgentLoop(isSidechain=true)
  ↓
子 Agent LLM 调用 → contextTracker.update(3000)   // 覆盖！子 Agent 自己只有 3K tokens
  ↓
状态栏读取 contextTracker.getState() → lastInputTokens = 3000  // 错误值
```

关键代码位置：

- **写入点**：`src/core/agent-loop.ts` `#callLLM()` 方法末尾
- **读取点**：`src/ui/StatusBar.tsx`、`src/ui/App.tsx`（`/context` 命令）、`src/core/context-manager.ts`（auto-compact 判断）

### 影响

| 影响面 | 严重程度 | 说明 |
|--------|---------|------|
| 状态栏 Ctx % 显示错误 | 中 | 用户看到的上下文占比偏低，失去参考价值 |
| `/context` 数据错误 | 中 | Used tokens 显示子 Agent 的值，而非主 Agent |
| Auto-Compact 失效 | 高 | 主 Agent 实际已 95% 但被子 Agent 覆盖为 3%，不触发压缩，可能导致后续 LLM 调用因上下文溢出报错 |

## 三、架构分析

### 为什么会有这个问题

`contextTracker` 设计时只考虑了单 AgentLoop 场景（主 Agent）。SubAgent 功能（F13）后续引入时，子 Agent 复用了 `AgentLoop` 的完整代码路径，包括 `contextTracker.update()` 调用，但没有隔离。

### 为什么子 Agent 不需要追踪上下文

| 维度 | 主 Agent | 子 Agent |
|------|---------|---------|
| History | 持续累积，跨多轮 | 一次性，任务完成即销毁 |
| 上下文压力 | 随对话增长逼近窗口上限 | 通常很小（prompt + 少量工具结果） |
| Auto-Compact | 需要 | 不需要（无持续 history） |
| UI 展示 | 用户关心 | 用户不关心（在 SubAgent Panel 看进度） |

子 Agent 有独立的 history、独立的 Provider session，其上下文消耗与主 Agent 完全无关。

## 四、解决方案

### 修改内容

**文件**：`src/core/agent-loop.ts` `#callLLM()` 方法

**改动**：增加 `isSidechain` 判断，子 Agent 跳过 `contextTracker.update()`

```typescript
// 修复前
if (inputTokens > 0) {
  contextTracker.update(inputTokens)
}

// 修复后
// 仅主 Agent 更新 — 子 Agent（isSidechain）有独立上下文，不应覆盖主 Agent 的追踪值
if (inputTokens > 0 && !this.#config.isSidechain) {
  contextTracker.update(inputTokens)
}
```

### 为什么不用更复杂的方案

| 备选方案 | 不采用原因 |
|---------|-----------|
| 每个 AgentLoop 持有独立 ContextTracker 实例 | 过度设计 — 子 Agent 不需要上下文追踪，创建实例纯浪费 |
| contextTracker 改为按 agentId 分桶存储 | 增加复杂度，且无消费方 — 没有 UI 展示子 Agent 的上下文占比 |
| 子 Agent 执行完后恢复主 Agent 的值 | 需要保存/恢复状态，且并发子 Agent 场景下有竞态问题 |

一行条件判断是最小改动，精准命中问题根因。

## 五、验证

- 修复后全量单元测试通过（669 passed）
- 手动验证：派发子 Agent 后状态栏 `Ctx %` 保持为主 Agent 的真实值，不再骤降
