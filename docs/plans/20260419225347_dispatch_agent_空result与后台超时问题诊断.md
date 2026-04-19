# dispatch_agent 空 result 与后台子 Agent 超时 — 诊断报告

> 基于实测会话 `019d9a75-7d07-77af-a130-98ee92cb9e96`(Web UI 入口 `http://localhost:9800/session/019d9a75-7d07-77af-a130-98ee92cb9e96`)的 JSONL 复盘。
>
> 会话文件:
> - 主: `C:\Users\ThinkPad\.ccode\sessions\D--a_dev_work-claude_cli_z01-cCli\20260417080124233_019d9a75-7d07-77af-a130-98ee92cb9e96.jsonl`
> - 子 Agent: `C:\Users\ThinkPad\.ccode\sessions\D--a_dev_work-claude_cli_z01-cCli\019d9a75-7d07-77af-a130-98ee92cb9e96\subagents\agent-a9490e6afda9d99e7.jsonl`

## 1. 用户反馈的两个现象

1. `dispatch_agent` 返回时 `result` 字段是空的。
2. 子 Agent 干活很久一直没返回成功。

结论剧透:这两个现象其实是**同一次调用**的两种观察角度 —— 子 Agent 用 `run_in_background=true` 派发、跑了 10 分钟被 timeout 强制停止、主 Agent 看到的始终是没有 `result` 字段的 `async_launched` 返回值。下面逐条拆。

---

## 2. 现象 1:`dispatch_agent` 的 `result` 为空

### 2.1 调用参数

主 Agent 的 `tool_call_start`(主会话 line 15):
```jsonc
{
  "toolName": "dispatch_agent",
  "args": {
    "name": "create-vue-project",
    "description": "创建 Vite+Vue3+pnpm 前端项目",
    "prompt": "请在 C:\\...\\新建文件夹 目录下创建一个前端项目,要求 ... pnpm + Vite + Vue 3 + TypeScript ... HelloWorld 组件 ...",
    "subagent_type": "general",
    "run_in_background": true   // ← 关键
  }
}
```

### 2.2 返回值(主会话 line 16,`resultFull` 节选)

```json
{
  "status": "async_launched",
  "agentId": "a9490e6afda9d99e7",
  "name": "create-vue-project",
  "agentType": "general",
  "model": "glm-5",
  "prompt": "...",
  "description": "创建 Vite+Vue3+pnpm 前端项目"
}
```

**注意:这里确实没有 `result` 字段。**

### 2.3 原因:schema 本就没有

`cCli/src/tools/agent/types.ts:99-159` 定义了 4 种 `dispatch_agent` 输出:

| Status | 触发场景 | 是否有 `result` | 替代字段 |
|---|---|---|---|
| `completed` | 前台(`run_in_background=false`)子 Agent 正常结束 | ✅ `result: string`(finalText) | — |
| `async_launched` | 后台派发成功立即返回 | ❌ **无** | 需通过 `task_output` 拉取 |
| `stopped` | 被用户/超时/父 Agent 停止 | ❌ 无(`result` 字段) | `partialResult: string` |
| `error` | 子 Agent 异常 | ❌ 无 | `partialResult?: string` + `error: string` |

源码节选:
```ts
// types.ts:110-119
export interface AgentAsyncLaunchedOutput {
  status: 'async_launched'
  agentId: string
  name: string
  agentType: string
  model: string
  prompt: string
  description: string
  // ← 没有 result,这是 by design
}
```

### 2.4 这里到底是不是 bug

**不是 bug,是协议设计**。后台派发的语义就是"立刻返回,结果稍后用 `task_output` 读"。三种观察角度都自洽:

- LLM 侧:看到 `status=async_launched` 就应该知道还没有结果,应当再调 `task_output` 拉;
- Web UI 侧:`SubAgentCard` 不渲染 `result`,只渲染 `status / turn / events`(见 `SubAgentCard.tsx`);
- JSONL 侧:`tool_call_end.resultFull` 原样存 JSON,没有 `result` 是真相。

**但这里有一个"潜在的误导"可能导致 LLM 困惑**:

`dispatch_agent.description`(`dispatch-agent.ts:58-91`)和子 Agent 的系统提示词(`built-in.ts` 里 general)里**没有明确告诉 LLM "result 字段只在 status=completed 时存在"**。弱模型(尤其 GLM-5)读到 async_launched 时,可能会误以为是"已完成但没结果"而不是"已启动等结果",然后就报告"result 为空"。

### 2.5 另一种真 bug 的可能(本次没发生,需警惕)

当 `run_in_background=false` **同步完成** 时,如果子 Agent 整个执行期间**一次 `text` 事件都没 yield**(只调工具,LLM 完全没产出自然语言),`finalText = ''`,返回的 `AgentCompletedOutput.result` 就真的是空字符串。

`dispatch-agent.ts:431-440`:
```ts
const output: AgentCompletedOutput = {
  status: 'completed',
  ...,
  result: finalText,  // ← 只要 finalText 是 '',这里就是空
}
```

弱模型在紧凑 prompt 下常见这种"闷头干活不说话"的行为,导致主 Agent 拿到 `{"status":"completed","result":""}`,会误判子 Agent 什么也没做。

---

## 3. 现象 2:子 Agent 干了 10 分钟没返回成功

### 3.1 Timeline(从主/子两份 JSONL 对齐)

| 时间戳 | 事件 | 来源 |
|---|---|---|
| 08:05:07.864 | 主 Agent `dispatch_agent` 启动(background) | 主 line 15 |
| 08:05:07.896 | 主 Agent 立即收到 `async_launched` | 主 line 16 |
| 08:05:07 ~ 08:10:33 | 子 Agent 自行工作(主 Agent 没polling,估计在干别的或等待) | — |
| 08:10:33.601 | 主 Agent 第 1 次 `task_output(block=true, timeout=300000)` | 主 line 19 |
| 08:15:33.607 | 主 Agent 收到 `[子 Agent 仍在运行 (turn 9/50)]` | 主 line 20 |
| 08:10:57 / 08:13:26 | 主 Agent 第 2 / 3 次 `task_output` | 主 line 23 / 31 |
| 08:15:12.903 | **子 Agent 10min 超时,lifecycle 写 stopped** | 子 line 63 |
| 08:15:12.917 | 主 Agent 第 4 次 `task_output` | 主 line 31 |
| 08:15:12.918 | 主 Agent 收到 `[子 Agent 已停止 (强制中断, 原因: 执行超时 600s)]` | 主 line 32 |
| 08:15:~ ~ 08:18:17 | 主 Agent 自己接手,读文件/改 style.css/跑 dev server/puppeteer 截图 | 主 line 35 起 |
| 08:18:17.268 | 主 Agent 给用户发"任务完成"总结 | 主 line 69 |

**关键事实:子 Agent 没挂死、没报错、没卡在 LLM 请求上 —— 它是被 600 秒超时 kill 的**。

### 3.2 超时来源

`cCli/src/tools/agent/built-in.ts:19-23`:
```ts
/** 通用型 Agent 超时:10 分钟(代码实现 + 构建 + 验证) */
const TIMEOUT_GENERAL_MS = 10 * 60 * 1000
```

`cCli/src/tools/agent/built-in.ts:49`:
```ts
const generalAgent: BuiltInAgentDefinition = {
  agentType: 'general',
  maxTurns: 50,
  timeoutMs: TIMEOUT_GENERAL_MS,  // ← 10 分钟
  ...
}
```

`cCli/src/tools/agent/dispatch-agent.ts:256-275` 里的 timeout 机制:
```ts
const effectiveTimeoutMs = definition.timeoutMs || (runInBackground ? 10 * 60 * 1000 : 0)
if (effectiveTimeoutMs > 0) {
  timeoutTimer = setTimeout(() => {
    const s = getSubAgent(agentId)
    if (s && s.status === 'running') {
      stopAgent(agentId, 'timeout', `执行超时 ${effectiveTimeoutMs / 1000}s`)
    }
    // 宽限期 5s 内没退出 → 强制 abort
    if (runInBackground) {
      setTimeout(() => {
        if (!subController.signal.aborted) subController.abort()
      }, 5_000).unref()
    }
  }, effectiveTimeoutMs)
}
```

所以当前配置下,background + general 子 Agent 的硬上限就是 10 分钟,这是**必须在 built-in.ts 改**的数字,LLM 不能通过 args 调整。

### 3.3 子 Agent 在这 10 分钟里到底干了什么

从 `task_output` 返回的 `resultFull`(主 line 32)拼出完整 tool call 序列:

| 轮次 | 工具 | 关键结果 | 耗时 |
|---|---|---|---|
| 1 | `todo_write` | 4 条任务初始化 | 1ms |
| 2 | `todo_write` | (同上,重复写) | 0ms |
| 3 | `bash` | `pnpm create vite hello-app` | 8730ms |
| 4 | `todo_write` | 1/4 completed | 0ms |
| 5 | `bash` | `pnpm install`(resolved/reused/downloaded) | 14623ms |
| 6 | `todo_write` | 2/4 completed | 0ms |
| 7 | `glob` | 列出 src/ 下文件 | 2ms |
| 8 | `read_file` | App.vue | 1ms |
| 9 | `read_file` | components/HelloWorld.vue(默认模板) | 1ms |
| 10 | `read_file` | style.css | 1ms |
| 11 | `read_file` | main.ts | 1ms |
| **12** | **`write_file`** | HelloWorld.vue **2799 字符** / 137 行 | 17ms |
| **13** | **`write_file`** | HelloWorld.vue **2720 字符** / 126 行 | 28ms |
| **14** | **`write_file`** | HelloWorld.vue **2665 字符** / 144 行 | 18ms |
| 15 | `read_file` | HelloWorld.vue(重读验证) | 10ms |
| 16 | `write_file` | style.css **117 字符** / 12 行 | 29ms |
| — | **timeout** | 第 15 轮的 LLM 响应还没来就被 kill | — |

**可见子 Agent 的 write_file 完全成功,工具零失败**。问题在第 12-14 轮 —— LLM 用不同字符数(2799 → 2720 → 2665)**把同一个 HelloWorld.vue 重写了 3 次**。

子 Agent 的最后一条 `assistant`(子 line 64):
> 现在查看项目的现有文件结构,然后修改 HelloWorld 组件。让我先写文件再检查结果。**看起来有缓存问题。让我直接读取文件并重新写入**:HelloWorld 组件已经写好了。现在更新 style.css 和 App.vue:

### 3.4 为什么重写?—— 根因定位

`write_file` 工具返回的成功文案(实际文本见 task_output resultFull):
> `✅ 文件已成功写入,无需重复写入。路径: ...,2799 字符 / 137 行。请继续执行下一个步骤。`

GLM-5 在读到这条**成功回执**后,被 "**无需重复写入**" 这个措辞误导 —— 模型把它解读为"因为某种缓存/去重机制,写入被拒绝了,所以我要再试一次"。于是进入循环:

```
LLM "我要写 HelloWorld.vue"
   → write_file 返回 ✅ + "无需重复写入"
   → LLM "看起来有缓存问题,再写一次"
   → write_file 返回 ✅ + "无需重复写入"
   → LLM "还是缓存问题,换个字符数写"
   → ... (3 轮后超时)
```

**这是弱模型 + 工具成功文案的二次幻觉**。`✅` 前缀本来是帮 LLM 识别成功的,但后半句"无需重复写入"在弱模型看来像一条**警告**而不是**赞扬**。

### 3.5 主 Agent 后来怎么"完成任务"的

子 Agent 被 kill 后,主 Agent(glm-5.1)看到 `[子 Agent 已停止 (强制中断, 原因: 执行超时 600s)]`,触发 `buildStopGuidance(source='timeout', resolution='forced')` 生成的行为指引,然后**自己接手**:
- 读 3 个文件(App.vue / HelloWorld.vue / style.css,主 line 35-40 并发)
- bash 跑 dev server(`pnpm dev`,line 41-43)
- puppeteer 访问 + 截图验证
- 最后 kill_shell
- 发送"✅ 任务完成"总结给用户(主 line 69)

主 Agent 其实**补完了子 Agent 没做完的美化工作**,但这不是预期的协作方式 —— 理想情况应该是子 Agent 自己交付完整结果,主 Agent 只做派发和汇总。

---

## 4. 两个现象合在一起看

一张图:

```
用户                              主 Agent                 子 Agent (background)
 │                                  │                          │
 │ 请求 "创建 Vue 项目"              │                          │
 ├─────────────────────────────►│                          │
 │                                  │ dispatch_agent          │
 │                                  ├─────────────────────────►│ (general, bg, 10min 超时)
 │                                  │ ← async_launched         │
 │                                  │   (无 result 字段)        │
 │                                  │                          │ ... scaffold ✅
 │                                  │                          │ ... install ✅
 │                                  │                          │ ... 读 4 个文件 ✅
 │                                  │                          │ ... write × 3 原地循环 ❌
 │                                  │ task_output × 3          │
 │                                  ├─────────────────────────►│
 │                                  │ ← 仍在运行 turn 9/11       │
 │                                  │                          │
 │                                  │                       [600s timeout]
 │                                  │                          │ → forced stop
 │                                  │ task_output #4           │
 │                                  ├─────────────────────────►│
 │                                  │ ← [已停止, 超时 600s]     │
 │                                  │                          X
 │                                  │ 主 Agent 自己接手收拾残局    │
 │                                  │ (读文件/跑 dev/截图)       │
 │                                  │                          │
 │ "✅ 任务完成"                    │                          │
 │ ◄─────────────────────────────┤                          │
```

**两个现象的同一根源**:
1. async_launched 本就没 `result` → 现象 1;
2. 子 Agent 跑 10min 被 kill → 子 Agent 的 partialResult 只是一段话而不是完整产出 → 现象 2;
3. **现象 2 的真正诱因是 write_file 成功文案导致弱模型死循环**,是个小文案问题放大成一个"看起来很严重的超时"。

---

## 5. 推荐修复方向(待审阅决策)

按"立刻做 vs 慢慢做"分层,每项都附上**预期效果**和**风险**。

### 5.1 [立刻做] 改 write_file 的成功文案 — 根治死循环诱因

**改动**: `cCli/src/tools/builtin/write-file.ts`(及 edit-file 如有类似文案)

当前:
```
✅ 文件已成功写入,无需重复写入。路径: <path>,<N> 字符 / <M> 行。请继续执行下一个步骤。
```

改成:
```
File written: <path> (<N> chars, <M> lines)
```

**预期效果**:
- 去掉"无需重复写入"这个歧义性修饰 — 弱模型不会把它当成警告
- 去掉"请继续执行下一个步骤"这种命令式措辞 — 避免浪费 token 给已经知道自己在干什么的模型
- 用英文短句让 tool result 更像 "data" 而不是 "conversation",避免被 LLM 当成一段对话参与推理

**风险**: 极低。需要简单回归一下 ink UI 的渲染(看起来 CLI 会把这句话直接打到屏幕上,减短不会影响显示)。

**工程量**: 15 分钟。

### 5.2 [立刻做] dispatch_agent description 增加"status=async_launched 时没有 result"说明

**改动**: `cCli/src/tools/agent/dispatch-agent.ts:58-91` 的 `get description()` 末尾追加:

```
返回结构约定:
- status="async_launched" 时,没有 result 字段,必须用 task_output 拉取结果
- status="completed" 时,result 字段包含最终文本输出
- status="stopped"  时,partialResult 字段包含中断前的已产出文本
- status="error"    时,error 字段包含错误消息
```

**预期效果**: 弱模型看 prompt 时有明确的字段契约,不会"期待不存在的字段"。

**风险**: 零。纯 prompt 追加。

**工程量**: 10 分钟。

### 5.3 [立刻做] 前台 dispatch 的 `result` 兜底 — 防真 bug 场景

**改动**: `cCli/src/tools/agent/dispatch-agent.ts:438`,把:
```ts
result: finalText,
```
改为:
```ts
result: finalText || '(sub-agent completed without text output; see tool calls in subagent JSONL)',
```

**预期效果**: 当前台子 Agent 只调工具不说话时,主 Agent 拿到的是一个**有意义的占位符**而不是空字符串,不会误判"子 Agent 啥也没做"。

**风险**: 低。主 Agent 可能在 tool result 的语义上有一次性的小冲击(原先是空,现在是英文说明),但不会导致功能行为变化。

**工程量**: 10 分钟。

### 5.4 [可选] 超时从 10min 提到 15min,或接受 LLM 在 args 里显式传 timeoutMs

**改动方向** A:`cCli/src/tools/agent/built-in.ts:21` 改 `TIMEOUT_GENERAL_MS = 15 * 60 * 1000`

**改动方向** B:`dispatch_agent.parameters` 增加可选的 `timeout_seconds` 参数,LLM 自己评估任务复杂度决定超时

**预期效果**: 复杂 scaffold 任务(create + install + 改多个文件)不至于临门一脚被 kill。

**风险**:
- A 方向:极低。只是把硬上限抬高,弱模型死循环的情况下会多烧 5 分钟 token。所以必须和 5.1 一起做(先掐死循环,再抬高上限)
- B 方向:中等。LLM 乱传 `timeout_seconds=3600` 就会把坏调用拖到 1 小时。需要设 hard cap。

**推荐**: 先走 A,等 5.1 落地后观察一波再决定要不要加 B。

**工程量**:A 方向 2 分钟。B 方向 1-2 小时。

### 5.5 [可选,观察用] 给 write_file 加重复写入检测 + early return

**改动**: `write-file` 工具在执行前读现有文件内容,如果新内容和旧内容**字节级完全一致**,直接返回:
```
File unchanged: <path> (content identical to existing, write skipped)
```

**预期效果**: 如果 LLM 真的错误地反复写同一个文件,第 2 次起就是 no-op,不会产生脏 I/O 和 tool round-trip 延迟。

**风险**: 低。但对正常使用场景几乎没收益(LLM 一般不会真的写一模一样的内容),主要是兜底死循环。**如果 5.1 生效,这个就不必要了**。

**工程量**: 30 分钟。

### 5.6 [不建议做] 给 general agent 塞 "don't repeat write_file" 到 system prompt

不做的理由:prompt engineering 防 LLM 偏离是**二阶方案**,一阶方案是消除诱因(5.1)。给 prompt 塞规则越多,弱模型越容易把规则和任务混淆。保持 prompt 简洁。

---

## 6. 推荐组合拳

**最小组合(建议)**:5.1 + 5.2 + 5.3,合计 ~40 分钟,全部是小改动 + prompt 文案调整,不动逻辑。

**加强组合**:上面 + 5.4 A 把超时提到 15min,合计 ~45 分钟。

**不推荐**:5.5 / 5.6。

---

## 7. 附带发现(与本次问题不直接相关但值得记录)

1. **主 Agent 在子 Agent timeout 后"自己把活干完"是 `buildStopGuidance(timeout, forced)` 预期内的行为**(`dispatch-agent.ts:550-556`),guidance 文案:
   ```
   ⚠️ 子 Agent 因超时被强制停止。
   请根据 partialResult 判断任务是否已完成足够的部分:
   - 若已完成关键部分,可总结已完成工作并询问用户是否继续。
   - 若进度很少,考虑调整策略(增加 timeoutMs、拆分任务)后再次派发。
   ```
   guidance 文案其实允许主 Agent 自己接手。但用户可能期待"子 Agent 死了就报告,不要主 Agent 代劳"—— 这是另一个**待讨论的策略选择**,和本次 bug 无关。

2. **主 Agent 模型是 glm-5.1,子 Agent 是 glm-5**。 跨模型协作下,主 Agent 的判断力略强于子 Agent,所以主 Agent 接手反而完成得更好 —— 间接证明 GLM-5 在这类任务上确实偏弱。

3. **主会话 69 行没有 `session_end`**,说明会话结束时没走正常的 finalize 流程(进程被 kill 或 UI 关闭),不影响本次分析但值得留意 session store 的健壮性。

---

## 8. 待决策点

- [ ] 是否立刻执行 5.1(改 write_file 文案)?
- [ ] 是否同步做 5.2 + 5.3(descriptions + 兜底)?
- [ ] 5.4 A(超时从 10→15min)是否一起做?
- [ ] "子 Agent timeout 后主 Agent 是否允许接手"这个策略问题是否开新 issue 讨论?

---

## 9. 最终方案 v2(讨论敲定版)

> 本节是 §5-§6 在与用户讨论后敲定的最终落地方案。和 §5-§6 有以下调整:
> - 文案全部改为中文(原版混英文)
> - 兜底文案**工具优先**:引导主 Agent 调 `task_output` 工具,而不是看 GUI 侧边栏
> - 对 async_launched 是否加 result 字段的讨论有结论(不加,用 description 契约表达)
> - 兜底逻辑覆盖面扩大:从"仅 completed 空 result"扩展到"stopped / error 的 partialResult 空值"
> - Fix-4 只保留 A 方向(改常量),不做 B 方向(LLM 传 timeout_seconds)

### 9.1 设计原则

| 原则 | 含义 |
|---|---|
| **工具优先,GUI 是人类工具** | 主 Agent 是 LLM,检视子 Agent 状态的天然接口是 `task_output(agent_id)`,不是 Web UI 侧边栏。任何引导文案都应指向工具调用 |
| **消除诱因优于添加规则** | 弱模型死循环的根本是 `write_file` 的"无需重复写入"措辞歧义。优先改掉这个诱因,而不是在 prompt 里加"不要重复写"之类的二阶规则 |
| **契约用 description 表达,不用数据结构堆字段** | async_launched 没有 result 是 by design,应该用 description 把 4 种 status 的字段约定讲清,而不是硬塞一个永远没值的 result 字段 |
| **兜底要覆盖所有"可能空"的路径** | 只修 completed 场景是漏网,stopped/error 的 partialResult 空值同样存在。一次改全,防隐患 |

### 9.2 已验证的前提

`task_output(agent_id)` 在子 Agent **已完成/已停止** 状态下同样可调(源码印证 `cCli/src/tools/core/task-output.ts:91-133`):
- 阻塞逻辑 `while (state.status === 'running' || state.status === 'stopping')` 只对 running/stopping 生效
- 完成态直接走同步输出:`[子 Agent 已完成/已停止...]` + 工具调用详情 + 停止报告 + `state.finalText`(有则带,无则省略)

所以主 Agent 即使对一个"已完成但 result 为空"的子 Agent,调 `task_output(agent_id)` 也能拿到完整的工具调用痕迹。**引导文案指向 task_output 是协议内自洽的,不是绕路**。

### 9.3 Fix 清单

#### Fix-1 · write_file 成功文案(及同类工具顺手查)

**目标**:去掉"无需重复写入 / 请继续执行下一个步骤"两句 —— 前者是死循环直接诱因,后者是对 LLM 的冗余命令。

| 项 | 内容 |
|---|---|
| 改动文件 | `cCli/src/tools/builtin/write-file.ts` |
| 顺手检查 | `cCli/src/tools/builtin/edit-file.ts` 是否有同类措辞 |
| 旧文案 | `✅ 文件已成功写入,无需重复写入。路径: <path>,<N> 字符 / <M> 行。请继续执行下一个步骤。` |
| 新文案 | `文件已写入: <path> (<N> 字符 / <M> 行)` |
| 设计要点 | 纯事实陈述、不加 emoji(`tool_result.success: true` 已是成功信号)、不给引导语(LLM 不需要被催)、中文 |

#### Fix-2 · dispatch_agent description 追加返回契约

**目标**:4 种 status 的字段约定讲清楚,LLM 不再"找不到 result 就懵"。

| 项 | 内容 |
|---|---|
| 改动文件 | `cCli/src/tools/agent/dispatch-agent.ts` 的 `get description()` |
| 追加位置 | 现有 description 末尾("其他注意事项"块之后) |
| 不修改字段结构 | async_launched 不加 result 字段(见 §9.4 讨论) |

追加文案(中文):

```
返回结构约定:
- status="async_launched" — 后台已启动但未完成,无 result 字段。
  获取结果请调用 task_output(agent_id=<返回的 agentId>)。
- status="completed"      — 前台同步完成,result 字段为子 Agent 的最终文本输出。
  若 result 为空占位符,同样可用 task_output 查看子 Agent 的工具调用详情。
- status="stopped"        — 被用户/超时/父 Agent 停止,partialResult 为中断前已产出文本,
  guidance 字段含下一步行为指引。
- status="error"          — 执行异常,error 字段为错误消息,partialResult 可选。
```

#### Fix-3 · result / partialResult 空值兜底(工具优先)

**目标**:子 Agent 没产出文本时,给主 Agent **可执行的下一步工具调用指引**,而不是空字符串。

| 项 | 内容 |
|---|---|
| 改动文件 | `cCli/src/tools/agent/dispatch-agent.ts` |
| 兜底文案(中文) | `(子 Agent 未产出文本输出,请调用 task_output(agent_id='<agentId>') 查看工具调用详情)` |
| 设计要点 | 指向 `task_output` 工具而非 GUI 侧边栏;嵌入真实 agentId,LLM 可直接复制参数调用 |

需要改的三个位置:

| 位置 | 字段 | 触发条件 |
|---|---|---|
| `dispatch-agent.ts:438` | `AgentCompletedOutput.result` | 前台同步完成但 finalText 为空 |
| `dispatch-agent.ts:419` / `:471` | `AgentStoppedOutput.partialResult` | 子 Agent 被停止且 finalText 为空 |
| `dispatch-agent.ts:493` | `AgentErrorOutput.partialResult` | 子 Agent 异常且 finalText 为空(当前可选,统一改为必填兜底) |

**原则**:一次改全三处,避免只修 completed 留下 stopped/error 的隐患。

#### Fix-4 · general agent 超时 10min → 15min

**目标**:重任务(scaffold + install + 多文件改)留更宽裕的时间窗。

| 项 | 内容 |
|---|---|
| 改动文件 | `cCli/src/tools/agent/built-in.ts:21` |
| 旧 | `const TIMEOUT_GENERAL_MS = 10 * 60 * 1000` |
| 新 | `const TIMEOUT_GENERAL_MS = 15 * 60 * 1000` |
| **依赖** | **必须在 Fix-1 生效之后**。先掐死循环诱因再抬上限,否则弱模型死循环场景下会多烧 5min token |
| 不动的常量 | `TIMEOUT_READONLY_MS = 5 * 60 * 1000`(explore/plan 只读型 Agent 保持不动,短任务不需要抬) |

### 9.4 关键设计决定的推理过程

#### 决定 1:async_launched 不加 result 字段

**问题**:"async 是不是也可以有返回值?"

**讨论的 4 种解读**:

| 解读 | 具体形态 | 推荐度 |
|---|---|---|
| A. 返回"初始计划" | 派发后等第 1 轮 LLM 响应再返回,result 放 plan | ❌ 破坏"立即返回不阻塞"核心价值;首轮往往是 tool_use 不是自然语言 |
| B. 返回"guidance"文本字段 | result 放固定字符串如 "请调用 task_output..." | ⚠️ 和 Fix-2 重复,选一个就够 |
| C. 完成后主动推结果给主 Agent | event-driven 注入 tool_result 到下一轮 | ❌ 破坏 tool_use/tool_result 一对一配对,改动巨大 |
| D. 不加字段,description 讲清契约 | 即 Fix-2 | ✅ **采用** |

**决定理由**:用户和 LLM "看到 async 没 result 感到困惑"的**根本原因是契约不清**,不是字段缺失。解决困惑用文档/description,不用冗余字段。"立即返回"是 background 模式的核心价值,不能为了字段完整性妥协。

#### 决定 2:兜底文案指向工具,不指向 GUI

**原问题**:第一版方案写的是 `(请查看 subagent 侧边栏的工具调用详情)`。

**用户反馈**:"GUI 只是一个人类手段,Agent 工程优先工具"。

**修正**:改为 `(请调用 task_output(agent_id='<id>') 查看工具调用详情)`。

**设计原则沉淀**:给 LLM 看的文案,**引导动作必须是 LLM 能执行的动作**(工具调用),而不是 LLM 无法执行的动作(看 GUI)。`task_output` 工具存在的意义就是让主 Agent 以工具方式检视子 Agent — 用它,别让 LLM 走 "看 UI" 这种反直觉的路径。

#### 决定 3:不加 `timeout_seconds` 参数给 LLM

**原讨论**:5.4 有 A(改常量)和 B(LLM 传 `timeout_seconds`)两个方向。

**决定**:只做 A。

**理由**:
- B 方向开口后,弱模型可能传奇葩值(如 3600 把坏调用拖 1 小时,或 60 让正常任务半死不活)
- 需要 hard cap + 下限校验 + description 讲清楚怎么用,工程量和风险都上去
- Fix-1 把死循环诱因掐掉后,15min 对绝大多数 scaffold 任务足够

#### 决定 4:兜底覆盖 stopped/error 而非只改 completed

**原方案**:只改 `dispatch-agent.ts:438` 的 `AgentCompletedOutput.result`。

**发现**:`AgentStoppedOutput.partialResult` 和 `AgentErrorOutput.partialResult` 同样用 `finalText`(见 `:419 / :471 / :493`),同样会空。

**修正**:一次改全三处,兜底文案一致。避免"只修了主路径,边缘路径埋雷"。

### 9.5 实施顺序 / 提交策略

**两个 commit**:

```
commit 1: fix(tool-prompts): 优化 write_file/dispatch_agent 工具返回文案,消除弱模型死循环诱因
  ├─ Fix-1: write_file 成功文案精简为纯事实陈述,移除"无需重复写入"等歧义措辞
  ├─ Fix-2: dispatch_agent description 追加 4 种 status 的返回结构契约说明
  └─ Fix-3: completed/stopped/error 场景 finalText 为空时兜底到 task_output 指引

commit 2: chore(agent): general 类型子 Agent 超时从 10min 调整为 15min
  └─ Fix-4: 依赖上游文案修复,避免弱模型循环场景下多烧 5min token
```

**commit 粒度理由**:
- Fix-1/2/3 都是 prompt/文案层,零逻辑分支改动,一起审方便
- Fix-4 是超时常量调整,影响运行时行为,单独提交便于独立 revert

### 9.6 人工回归点

1. CLI(Ink)渲染 write_file tool_result 的截断逻辑 — 文案变短了,看看 `ToolStatus` 之类还 OK
2. 跑 `write_file` 的 unit test — 文案变了,断言如果包含旧字符串需要同步改
3. `dispatch_agent` unit test / integration test — description 变长了,如果有 description 长度或关键词断言需要同步
4. 手动测一次弱模型(GLM-5)的 scaffold 任务,观察是否还有 write_file 循环

### 9.7 不在本次范围

| 事项 | 去向 |
|---|---|
| LLM 传 `timeout_seconds` 参数(5.4-B) | 搁置,风险高于收益 |
| async_launched 加 result 字段 | 已决定不加(见 §9.4 决定 1) |
| "子 Agent timeout 后主 Agent 是否允许接手" 的策略选择 | 独立产品决策,另议 |
| 给 write_file 加"重复写入检测 + early return"(§5.5) | 如 Fix-1 生效则不必要,观察后再定 |
| 给 general agent 的 system prompt 塞"禁止重复 write_file"规则(§5.6) | 二阶方案,不做 |

### 9.8 签收

- [ ] Fix-1(write_file 文案)
- [ ] Fix-2(description 契约)
- [ ] Fix-3(三处 result/partialResult 兜底)
- [ ] Fix-4(超时 10→15min)
- [ ] 上述 4 项按 commit 1 / commit 2 拆分提交
- [ ] 本节作为后续实施时的 source of truth,如有偏离需回写更新本节
