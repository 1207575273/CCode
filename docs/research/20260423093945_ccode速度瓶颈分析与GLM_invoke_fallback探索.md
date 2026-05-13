# ccode 速度瓶颈分析与 GLM invoke fallback 待深探

> 日期:2026-04-23
> 分析对象:会话 `~/.ccode/sessions/D--a_dev_work-claude_cli_z01-cCli/20260423011210397_019db7e4-fb9c-764a-acdc-f7f03090e513.jsonl`
> 运行配置:`provider=glm-max`、`model=glm-5.1`、`protocol=openai`、`baseURL=https://open.bigmodel.cn/api/coding/paas/v4`

---

## 一、一句话结论

**ccode 干活慢,根因是 GLM 厂商侧 — TTFT 高 + 没有 prompt cache。客户端能做的优化空间有限,但 `openai-compat.ts` 的 `invoke fallback` 值得单独追查,它可能在不被察觉的情况下把单次请求延长几十秒。**

---

## 二、会话整体耗时分解

| 阶段 | 耗时 | 占比 |
|---|---|---|
| **LLM 调用(网络往返 + 模型推理)** | **686.9s** | **72.5%** |
| 工具执行(bash / mcp / write_file 等) | 111.5s | 11.8% |
| permission_grant / 空闲等待 | ~148.8s | 15.7% |
| **总计 wall-clock** | **947.2s ≈ 15.8 分钟** | 100% |

LLM 是绝对的瓶颈,工具和交互都不是主要矛盾。

---

## 三、LLM 调用细分(28 次)

### 关键指标

| 指标 | 值 | 说明 |
|---|---|---|
| 累计 TTFT(首 token 等待) | **560.7s** | **占 LLM 总耗时 81.6%** — 真正的瓶颈 |
| 累计 e2e | 686.9s | e2e 比 TTFT 多 126s,这部分是"吐 token 阶段" + 可疑的 fallback |
| 平均 TTFT | 20.0s | 对比 Claude Sonnet 通常 1–3s |
| 最慢单次 TTFT | 74.0s | idx=2:input=24k,等了 74 秒首 token |
| 累计 input tokens | 594,261 | 多轮工具调用,每次重传完整上下文 |
| 累计 output tokens | 10,897 | input / output ≈ 54:1 |
| 平均 TPS | 15.86 tok/s | 中规中矩 |
| **cacheRead / cacheWrite** | **0 / 0** | **全程零命中** |

### 极端慢点样本

| idx | input | output | TTFT | e2e | TPS | 备注 |
|---|---|---|---|---|---|---|
| 0 | 11872 | 157 | 34.3s | 34.3s | 4.6 | 冷启动 |
| 2 | 24344 | 2188 | **74.0s** | 74.0s | 29.6 | 单次最慢 TTFT |
| 4 | 24568 | 68 | 47.3s | 47.3s | **1.4** | 等 47s 只吐 68 tok |
| 5 | 12341 | 808 | 7.8s | **28.7s** | 38.7 | **TTFT 与 e2e 差 21s,疑似 fallback** |
| 14 | 14557 | 2471 | 6.8s | **65.9s** | 41.8 | **TTFT 与 e2e 差 59s,强烈疑似 fallback** |
| 20 | 35036 | 54 | 27.2s | 27.2s | **2.0** | 长上下文 + 极短输出 |
| 22 | 35592 | 76 | 25.2s | 25.2s | 3.0 | 同上 |
| 23 | 35704 | 90 | 26.6s | 26.6s | 3.4 | 同上 |

**规律**:input 超过 24k 后 TTFT 普遍 25s+,到 35k 时 27s。GLM-5.1 的 prefill 对长上下文扩展性差。

---

## 四、为什么是厂商问题(非 ccode 问题)

### 4.1 GLM 没有 prompt cache(已验证)

- 用户确认:GLM 不管走 `openai` 协议(`/api/coding/paas/v4`)还是 `anthropic` 协议(`/api/anthropic`),**服务端都没有 prompt cache 能力**。
- 对比:同样 28 次多轮调用、累计 60 万 input tokens 的场景,Claude 原生 API + `cache_control` 打点,典型命中率 > 90%。input 计费降到 1/10,TTFT 从 20s 可降到 1–2s(cache_read 比 cache_miss 的 prefill 快 5–10 倍)。GLM 完全吃不到这个红利。

### 4.2 GLM 长上下文 prefill 慢

- input=24k 时 TTFT 47s,input=35k 时 TTFT 27s — 推测服务端有动态排队/负载均衡,但对长前缀不友好。
- 这个不是客户端能绕开的。

### 4.3 GLM 流式 + 工具调用有已知 bug → 触发客户端 fallback

- 见 [`src/providers/openai-compat.ts:136-180`](../../cCli/src/providers/openai-compat.ts):当 `finish_reason=tool_calls` 但流式响应里 `tool_calls` 为空时,客户端先从 `additional_kwargs` 回捞,回捞失败再 **调用 `model.invoke()` 非流式重试整个请求**。
- 非流式重试会整整多跑一次完整请求,代价极大(尤其 input 已经几万 tokens)。
- idx=14(TTFT 6.8s / e2e 65.9s,差 59s)极可能就是触发了这条路径。

---

## 五、客户端侧的观察与小隐患

### 5.1 cache 字段提取用 Anthropic 命名(非阻塞)

[`src/providers/openai-compat.ts:126-127`](../../cCli/src/providers/openai-compat.ts):

```ts
cacheReadTokens: usageMeta.cache_read_input_tokens ?? 0,
cacheWriteTokens: usageMeta.cache_creation_input_tokens ?? 0,
```

OpenAI 规范的字段是 `usage.prompt_tokens_details.cached_tokens`,完全不同。
**当前 GLM 没 cache,不影响。** 未来如果 GLM 或其他 OpenAI 兼容厂商开启自动 cache,这里读不出来。

### 5.2 openai-compat 的 system prompt 不做 cache 优化

这没毛病 — OpenAI 规范下 cache 是服务端自动行为,客户端无法主动标记。但 ccode 的 `anthropic.ts` 走的是显式 `cache_control: ephemeral` 打点,两种路径的 cache 策略完全不对称。

---

## 六、⚠️ 待深入探索:`invoke fallback` 黑盒

### 6.1 现象

`openai-compat.ts` 针对 "GLM 流式 + 工具调用" 的 bug 写了两层 fallback:

1. **fallback 1**:从 `final.additional_kwargs.tool_calls` 恢复 — 轻量,只读数据。
2. **fallback 2**:`model.invoke(langchainMsgs)` 非流式重新请求 — **重,等于多一次完整 LLM 调用**。

但目前的日志只在 TTFT / e2e 数字上看到"某些调用 e2e 远大于 TTFT",**无法直接确认哪些调用触发了 fallback、触发了哪一层、是否成功**。

### 6.2 为什么需要深探

- idx=14 有 **59 秒** 的 TTFT/e2e 差,如果是 fallback 2,意味着每次触发等同于吞掉一次完整慢请求。
- 如果 fallback 触发率高,这部分耗时在"LLM 调用"总量里是隐藏的 — 用户只看到慢,不知道是模型慢还是我们"为了救模型"多打了一次。
- fallback 2 里用 `model.invoke`,这是 LangChain 的非流式接口,会不会在 signal 取消、usage 上报、tool_calls 映射上与流式路径有差异?目前代码注释没写清楚,需要验证。

### 6.3 建议的探索方向(下次专项)

1. **加 telemetry**:在 fallback 1 / fallback 2 命中时各自打一条 `observability` 事件(类型如 `llm_fallback_hit`),带 `level` 和 `recovered_calls` 字段。这样能从 session 日志直接看到触发率和耗时。
2. **触发率统计**:回溯历史 session,统计 GLM 场景下 fallback 2 命中率。如果 > 10%,值得推动厂商修复或切换接口版本。
3. **替代方案调研**:
   - 智谱是否有"非流式 + 工具"的原生稳定接口?直接走非流式可能比"先流式再 invoke 兜底"更省。
   - 能否改为 `stream_options: { include_usage: true }` 以外的更细配置,让 GLM 在流中完整返回 tool_calls?
4. **失败路径验证**:当前 fallback 2 内部 `try/catch` 吞掉错误(只打 dbg 日志),用户侧看到的是"LLM 啥也没返回"。这个静默失败需要升级为显式错误事件。
5. **invoke 路径的 usage 上报**:`model.invoke` 的返回值 usage 是否被读取?看当前代码 fallback 2 只提取 `tool_calls`,完全没处理 usage,意味着走到 fallback 2 的调用 **token 计量会丢失**,日志里的 inputTokens/outputTokens 可能偏少。需要核对。

---

## 七、验证建议(可立刻做,无需改代码)

在同一个项目里,临时切到 `claude-sonnet-4-6`(走 anthropic 协议 + prompt cache)跑一段类似规模的会话,对照:

- TTFT 曲线是否从平均 20s 降到 1–3s。
- `cacheRead` 是否占 input 80%+。
- 总 wall-clock 是否下降到 3–5 分钟级别。

如果是,就坐实了 **瓶颈 100% 在 GLM 服务端**,也能给"换模型 vs 继续优化客户端"的决策提供数据支撑。

---

## 八、后续行动项(按优先级)

| 优先级 | 项 | 负责 |
|---|---|---|
| P0 | 针对 `openai-compat.ts` fallback 路径加 telemetry,量化触发率和耗时开销 | 下次专项 |
| P0 | 核对 fallback 2 是否丢失 usage 上报(静默丢 token 计量) | 下次专项 |
| P1 | fallback 2 失败时升级为显式错误事件,不要静默吞 | 下次专项 |
| P1 | 调研 GLM 是否有更稳定的"流式 + 工具"接口版本,避免客户端兜底 | 待定 |
| P2 | `openai-compat.ts` cache 字段提取兼容 OpenAI 规范 `prompt_tokens_details.cached_tokens` | 等厂商先支持 |
| — | 发现 GLM 慢就换 Claude/GPT 官方模型跑关键任务 | 使用侧决策 |

---

## 附:原始数据(供复核)

### LLM 调用完整明细

```
idx      in   out  cacheR cacheW  ttftMs  e2eMs    tps  stop
  0   11872   157      0      0   34292  34292    4.6   tool_use
  1   12055   340      0      0   16041  21509   62.2   tool_use
  2   24344  2188      0      0   74013  74013   29.6   tool_use
  3   24454  1934      0      0   66871  66871   28.9   tool_use
  4   24568    68      0      0   47310  47310    1.4   tool_use
  5   12341   808      0      0    7849  28724   38.7   tool_use
  6   12407    48      0      0    7335   8391   45.5   tool_use
  7   13217   172      0      0    5552  10357   35.8   tool_use
  8   13316    47      0      0    5163   6910   26.9   tool_use
  9   27066    70      0      0   14269  14269    4.9   tool_use
 10   13931    50      0      0   16356  17675   37.9   tool_use
 11   28340   328      0      0   27786  27786   11.8   tool_use
 12   14275    46      0      0    5434   7048   28.5   tool_use
 13   14445   105      0      0   10836  13600   38.0   tool_use
 14   14557  2471      0      0    6766  65881   41.8   tool_use   ← TTFT/e2e 差 59s
 15   14811   159      0      0    3265   6850   44.4   tool_use
 16   17142    66      0      0    8404  10349   33.9   tool_use
 17   34458   384      0      0   32231  32231   11.9   tool_use
 18   34636   322      0      0   17984  17984   17.9   tool_use
 19   17422    49      0      0   12942  15197   21.7   tool_use
 20   35036    54      0      0   27212  27212    2.0   tool_use
 21   17728    54      0      0    8198   9431   43.8   tool_use
 22   35592    76      0      0   25150  25150    3.0   tool_use
 23   35704    90      0      0   26637  26637    3.4   tool_use
 24   17977    94      0      0    9066  11926   32.9   tool_use
 25   18078    18      0      0   12315  13344   17.5   tool_use
 26   36254   256      0      0   24862  24862   10.3   tool_use
 27   18235   443      0      0    6595  21057   30.6   end_turn
```

### 工具调用分布

```
bash                                count= 11  total=84.8s   (单次最慢 20.4s)
write_file                          count= 11  total=6.8s
read_file                           count=  7  total=0.0s
todo_write                          count=  5  total=0.0s
mcp__puppeteer__puppeteer_screenshot count=  1  total=9.0s
mcp__puppeteer__puppeteer_navigate  count=  1  total=5.5s
mcp__puppeteer__puppeteer_evaluate  count=  1  total=5.4s
task_output                         count=  1  total=0.0s
kill_shell                          count=  1  total=0.0s
```
