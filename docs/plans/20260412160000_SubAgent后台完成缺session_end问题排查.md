# SubAgent 后台完成缺 session_end 问题排查

> 创建时间: 2026-04-12
> 状态: **已修复**

## 一、问题现象

### 1.1 E2E 测试发现

通过 E2E 测试 `test-subagent-stop.sh` 生成的 session JSONL 分析发现：

| 测试 | 子 Agent 行为 | lifecycle | session_end | status |
|------|--------------|-----------|-------------|--------|
| 1. 后台执行 + task_output | **正常完成**（创建 marker.txt） | 无 | **缺失** | — |
| 2. control_agent 停止 | **被停止**（sleep 60 被中断） | 有 (stopped/graceful) | 有 | stopped |
| 3. 前台多轮执行 | **正常完成**（创建+读取文件） | 无 | 有 | done |
| 4a. fast-task（后台） | **正常完成**（echo fast-ok） | 无 | **缺失** | — |
| 4b. slow-task（后台） | **被停止**（control_agent） | 无 | **缺失** | — |

### 1.2 规律总结

- **前台正常完成**: 有 `session_end`，status=done ✅
- **后台被停止**: 有 `lifecycle` + `session_end`，status=stopped ✅（测试2）
- **后台正常完成**: **缺失 `session_end`** ❌（测试1、测试4a）
- **后台被停止（多Agent场景）**: **缺失 `session_end`** ❌（测试4b）

核心问题：**后台模式（run_in_background=true）的子 Agent，无论正常完成还是被停止，在大多数情况下缺少 `session_end` 事件。**

### 1.3 影响

1. **审计链断裂** — 无法从 JSONL 判断后台子 Agent 的最终状态和资源消耗
2. **停止机制不可靠** — `session_end` 是终态标记，缺失意味着停止流程可能没有走完整路径
3. **token 用量丢失** — `session_end` 中汇总的 token 统计丢失，影响成本追踪

## 二、根因分析

### 2.1 直接原因：子 Agent 的 `for await` 循环永远不结束

通过 JSONL 事件序列分析，所有缺失 `session_end` 的后台子 Agent 都遵循同一模式：

**子 Agent 事件序列（以测试1为例）：**
```
session_start → user
TURN 0: llm_call_start → llm_call_end(tool_use) → tool_start(write_file) → tool_done
TURN 1: llm_call_start → llm_call_end(tool_use) → tool_start(write_file) → tool_done
TURN 2: llm_call_start → llm_call_end(tool_use) → tool_start(read_file)  → tool_done
TURN 3: llm_call_start → llm_call_end(end_turn)  ← 任务已完成，LLM 返回纯文本
TURN 4: llm_call_start  ← minTurns 续跑！但 LLM 调用永远没有返回 llm_call_end
```

关键观察：
- **TURN 3**: LLM 返回 `end_turn`（无工具调用），任务已实际完成
- **但** `toolRounds=3 < minTurns=5`，触发 AgentLoop 的续跑机制（agent-loop.ts:221-228）
- **TURN 4**: 续跑注入"继续执行"消息后，发起新一轮 LLM 调用
- **TURN 4 的 LLM 调用永远没有返回** — generator 挂在 `for await (const chunk of provider.chat(...))` 上

### 2.2 为什么前台模式不受影响？

前台模式下，`dispatch_agent.stream()` 的 `for await` 循环会消费子 AgentLoop 的所有事件。主 AgentLoop 也同步等待 dispatch_agent 完成。整个调用链是同步的，LLM 调用有充足时间完成。

### 2.3 为什么测试2（control_agent 停止）不受影响？

测试2的子 Agent 在 TURN 0（`bash` 执行 `sleep 60`）期间就被 `control_agent` 停止了。
`requestStop()` → `#stopRequested=true` → 检查点触发 → `yield { type: 'done', reason: 'stopped' }`。
子 Agent 在工具执行期间被停止，没有进入续跑路径，因此正常走完了 `session_end` 流程。

### 2.4 完整因果链

```
generalAgent.minTurns = 5（built-in.ts:47）
    ↓
子 Agent 完成 3 轮工具调用后 LLM 返回 end_turn
    ↓
AgentLoop.run() 中 toolRounds(3) < minToolRounds(5)（agent-loop.ts:223）
    ↓
注入"继续执行"消息 → 继续循环（agent-loop.ts:224-228）
    ↓
新一轮 LLM 调用发起（agent-loop.ts:199 yield* callLLM）
    ↓
LLM 调用挂住（可能是模型端无响应/超时/流中断）
    ↓
后台 void (async () => { ... })() 的 for-await 循环永远卡在 generator 的 yield 上
    ↓
subLogger.finalize() 永远不会被调用
    ↓
session_end 事件永远不会写入 JSONL
```

### 2.5 根因确认：minTurns 续跑 + 后台 fire-and-forget + LLM 无响应

三个条件缺一不可：

1. **minTurns > 实际工具轮次**：general Agent 的 minTurns=5，但实际任务可能 2-3 轮就完成了
2. **后台模式 fire-and-forget**：`void (async () => { ... })()` 没有被 await，也没有超时机制来中断挂起的 LLM 调用
3. **LLM 调用无响应**：续跑注入的消息导致 LLM 发起新一轮调用，但这轮调用因为某种原因（模型端超时、连接中断、流错误）永远没有返回

其中第 3 点可能是间歇性的（取决于模型负载），但第 1 点和第 2 点是结构性的。

## 三、问题分类

这是**两个 bug 的组合**：

### Bug A：minTurns 续跑机制在后台模式下不合理

- **问题**：minTurns 的设计初衷是防止弱模型（GLM）提前退出，但在后台模式下，子 Agent 已经完成了任务却被迫续跑
- **影响**：浪费 token、延长执行时间、增加 LLM 调用失败概率
- **定位**：`agent-loop.ts:221-228`（续跑逻辑）、`built-in.ts:47`（minTurns=5）

### Bug B：后台 Promise 没有全局超时保护

- **问题**：后台 `void (async () => { ... })()` 中，`for await (subLoop.run(...))` 可能因为 LLM 无响应而永远挂起，没有超时中断机制
- **影响**：session_end 永远不写入、子 Agent 状态永远停在 `running`
- **定位**：`dispatch-agent.ts:493`（void async IIFE）、缺少 AbortSignal 超时绑定

### Bug C（次要）：timeoutMs 绑定在 stopAgent 上，不直接中断 LLM 调用

- **问题**：`definition.timeoutMs` 通过 `stopAgent()` 发起优雅停止，但如果 LLM 调用挂住，优雅停止无法生效（requestStop 只在检查点触发）
- **影响**：超时后 AgentLoop 仍然卡在 LLM 流中，直到宽限期超时后 AbortController.abort() 才强制中断
- **定位**：`dispatch-agent.ts:209-215`（timeoutTimer）、`store.ts:405-409`（grace period abort）

## 四、修复方案

### 方案 1：后台模式禁用 minTurns 续跑（推荐，解决 Bug A）

**原理**：后台模式下子 Agent 已完成任务就应立即退出，不需要续跑。

**改动**：在 `AgentLoop.run()` 的续跑检测中，增加后台模式判断：

```typescript
// agent-loop.ts:222-228
if (llmResult.toolCalls.length === 0) {
  // 续跑检测：仅前台 SubAgent 且工具轮次不足时注入继续消息
  // 后台 SubAgent 已完成任务就应退出，不强制续跑
  if (toolRounds < minToolRounds && this.#config.isSidechain && !this.#config.isBackground) {
    history.push({ ... })
    continue
  }
  yield { type: 'done', reason: 'complete' }
  return
}
```

需要在 AgentLoopConfig 中新增 `isBackground` 字段，在 `runSubAgentInBackground` 创建 AgentLoop 时传入。

### 方案 2：后台 Promise 增加全局超时（解决 Bug B + C）

**原理**：即使禁用了续跑，LLM 调用本身也可能无响应。需要全局超时强制中断。

**改动**：在 `runSubAgentInBackground` 中，用 `AbortController` + `setTimeout` 绑定全局超时：

```typescript
// dispatch-agent.ts - runSubAgentInBackground 内
const bgAbortController = new AbortController()
const bgTimeout = setTimeout(() => {
  bgAbortController.abort()  // 强制中断 for-await 循环
}, definition.timeoutMs ?? 10 * 60 * 1000)

// 将 bgAbortController.signal 传给 AgentLoop 的 subController
// 超时后 → AbortError → catch 块 → finalize('error') → session_end 写入
```

### 方案 3（补充）：E2E 测试修复测试 5 的 session 路径

**改动**：`test-subagent-stop.sh` 测试 5 中的 `SESSION_DIR` 路径需要改为 cCli 实际的按-cwd-分组结构。

## 五、建议执行顺序

1. **方案 1**（禁用后台续跑）— 根因修复，消除大部分场景下的问题
2. **方案 2**（全局超时）— 防御性兜底，覆盖 LLM 无响应等极端情况
3. **方案 3**（E2E 路径修复）— 测试完善

## 六、实际修复记录（2026-04-12）

### 已实施的改动

| 文件 | 改动 |
|------|------|
| `src/core/agent-loop.ts` | `AgentConfig` 新增 `isBackground` 字段；续跑检测增加 `!isBackground` 条件 |
| `src/tools/agent/dispatch-agent.ts` | 后台 AgentLoop 传入 `isBackground: true` + 不传 `minTurns`；timeoutTimer 后台模式 5s 后强制 abort；`onParentAbort` 回调中防御性 `subLogger.finalize('error')` |
| `src/observability/session-logger.ts` | `finalize()` 改为幂等（`#finalized` 标志），防止重复写入 session_end |
| `tests/e2e/` | 拆分为 5 个独立脚本 + common.sh + 统一入口 |

### 验证结果

- **658 单元测试通过**（零回归）
- **E2E 测试 1（后台执行 + task_output）**：2 passed, 0 failed ✅
- **E2E 测试 3（前台 SubAgent）**：2 passed, 0 failed ✅
- **E2E 测试 5（JSONL 审计）**：3 passed, 0 failed ✅ — **所有子 Agent 都有 session_end**
