# AsyncIterable 与 AsyncGenerator 的魔法细节 — 从 AgentLoop.run() 的类型签名说起

> 写作缘起：审视 `cCli/src/core/agent-loop.ts` 时发现 public 的 `run()` 方法
> 返回类型是 `AsyncIterable<AgentEvent>`，但同文件内的 4 个私有方法全部用的是
> `AsyncGenerator<AgentEvent, ...>`。实现是用 `async function*` 写的，
> 声明却退化成更宽的 `AsyncIterable`。这个不一致背后是对 JavaScript 异步迭代
> 协议的理解问题 —— 很多人分不清"协议"和"实现"，更分不清"类型标注"和"运行时行为"。
> 本文把这套机制从底往上讲透，再回到改造与收益。

---

## 一、一切从协议说起

### 1.1 同步迭代协议（Iterable / Iterator）

ES2015 引入 `for...of` 的同时，定义了一对协议：

```ts
interface Iterable<T> {
  [Symbol.iterator](): Iterator<T>
}

interface Iterator<T> {
  next(): IteratorResult<T>
  return?(value?: unknown): IteratorResult<T>
  throw?(err?: unknown): IteratorResult<T>
}

interface IteratorResult<T> {
  value: T | undefined
  done: boolean
}
```

这两个接口的关系：**`Iterable` 只是一张"拿到 `Iterator` 的票据"**。只要你实现了 `[Symbol.iterator]` 方法，你就是一个 iterable；真正产出值的工作在 `Iterator.next()` 里。

```ts
// 手写一个 iterable，计数到 n
class Counter implements Iterable<number> {
  constructor(private readonly n: number) {}
  [Symbol.iterator](): Iterator<number> {
    let i = 0
    const n = this.n
    return {
      next(): IteratorResult<number> {
        if (i < n) return { value: i++, done: false }
        return { value: undefined, done: true }
      }
    }
  }
}

for (const x of new Counter(3)) console.log(x)   // 0, 1, 2
```

这里有个细节：**同一个 Iterable 可以产出多个 Iterator**。每次调用 `[Symbol.iterator]()` 都创建新的迭代器，状态互不干扰。像数组：

```ts
const arr = [1, 2, 3]
const it1 = arr[Symbol.iterator]()
const it2 = arr[Symbol.iterator]()
it1.next()       // { value: 1, done: false }
it2.next()       // { value: 1, done: false } — 独立状态
```

### 1.2 异步迭代协议（AsyncIterable / AsyncIterator）

ES2018 新增了异步版本，几乎是把每个返回值都套了一层 `Promise`：

```ts
interface AsyncIterable<T> {
  [Symbol.asyncIterator](): AsyncIterator<T>
}

interface AsyncIterator<T> {
  next(): Promise<IteratorResult<T>>
  return?(value?: unknown): Promise<IteratorResult<T>>
  throw?(err?: unknown): Promise<IteratorResult<T>>
}
```

`for await...of` 就是靠这套协议驱动的：

```ts
for await (const x of someAsyncIterable) {
  // 编译器展开成大致这样：
  // const it = someAsyncIterable[Symbol.asyncIterator]()
  // while (true) {
  //   const { value, done } = await it.next()
  //   if (done) break
  //   const x = value
  //   /* 循环体 */
  // }
}
```

重点：**`for await...of` 从不调用 `return()` 或 `throw()`**（只调 `next()`）。它们存在是为了**提前退出**和**注入错误**这两个场景。

### 1.3 协议 vs 实现

抓住一个关键区分：

- **协议（Protocol）**：一组约定的方法签名。任何对象只要"长得像"就算。
- **实现（Implementation）**：具体的某个类或函数的产物，带有具体的行为语义。

`AsyncIterable` 是**协议**，它只约定了一件事：问我要迭代器，我给你一个。

**谁能成为 `AsyncIterable`？**

1. 手写 class 实现 `[Symbol.asyncIterator]`
2. 手写普通对象字面量 + `[Symbol.asyncIterator]`
3. `async function*` 生成的生成器（下一节讲）
4. Node.js 的 `Readable` 流（默认实现了异步迭代协议）
5. Web API 的 `ReadableStream`（从 Node 18 开始）
6. 第三方库（rxjs 的 `Observable.from`、ix-node 等）

这一节的核心：**不要把 `AsyncIterable` 当成某种具体的"东西"，它只是一份契约。**

---

## 二、生成器（Generator）—— ES 的第一块魔法

### 2.1 同步生成器语法糖

```ts
function* range(n: number) {
  for (let i = 0; i < n; i++) yield i
}

const g = range(3)
g.next()   // { value: 0, done: false }
g.next()   // { value: 1, done: false }
g.next()   // { value: 2, done: false }
g.next()   // { value: undefined, done: true }
```

`function*` 是**语法糖**，背后引擎会把函数体编译成一个**状态机**。每次调用 `next()`，状态机从上次 `yield` 的位置往后执行，直到遇到下一个 `yield` 或 `return`。

状态机的伪代码大致长这样：

```ts
function* range(n: number) { /* 源代码 */ }
// 引擎大致编译成：
function range(n: number) {
  let state = 0      // 当前状态
  let i = 0          // 局部变量提升到闭包
  return {
    next() {
      while (true) {
        switch (state) {
          case 0:
            if (i < n) { state = 1; return { value: i++, done: false } }
            state = 2; break
          case 1:
            state = 0; break
          case 2:
            return { value: undefined, done: true }
        }
      }
    },
    return(value) { state = 2; return { value, done: true } },
    throw(err) { state = 2; throw err },
    [Symbol.iterator]() { return this },
  }
}
```

关键洞察：
- `yield` 不是 return，而是**挂起**（保存局部变量 + 程序计数器），把控制权交回调用者
- `next()` 是**恢复**，从上次挂起的地方继续跑
- 生成器函数被调用后**不立即执行**，只返回一个 iterator 对象

### 2.2 Generator 类型的三个参数

TypeScript 对生成器的类型建模非常完整：

```ts
interface Generator<T = unknown, TReturn = any, TNext = unknown>
  extends Iterator<T, TReturn, TNext> {
  next(...args: [] | [TNext]): IteratorResult<T, TReturn>
  return(value: TReturn): IteratorResult<T, TReturn>
  throw(e: unknown): IteratorResult<T, TReturn>
  [Symbol.iterator](): Generator<T, TReturn, TNext>
}
```

三个类型参数：

- `T` — 每次 `yield` 的值的类型
- `TReturn` — 生成器执行完（显式 `return value` 或跑完函数体）时的 `value` 类型
- `TNext` — 调用方通过 `next(x)` 传回生成器的值的类型，也就是 `yield` **表达式本身的返回值类型**

第三个参数很多人不知道。`yield` 实际上是个**双向通道**：

```ts
function* conversation(): Generator<string, void, number> {
  const a = yield 'give me a number'   // a 的类型是 number
  const b = yield `you gave ${a}`
  yield `ok, sum = ${a + b}`
}

const g = conversation()
g.next()      // { value: 'give me a number', done: false }
g.next(10)    // a = 10，yield 'you gave 10'
g.next(20)    // b = 20，yield 'ok, sum = 30'
```

`next()` 的参数就是下一个 `yield` 表达式的返回值。这是协程式通信的基础。

不过 async generator 里的 `TNext` 用得极少，绝大多数场景是单向输出，`TNext = unknown` 就好。

### 2.3 异步生成器 `async function*`

```ts
async function* range(n: number) {
  for (let i = 0; i < n; i++) {
    await new Promise(r => setTimeout(r, 100))
    yield i
  }
}

for await (const x of range(3)) console.log(x)   // 0, 1, 2（每个间隔 100ms）
```

`async function*` 返回的是 `AsyncGenerator<T, TReturn, TNext>`。它的 `next()` 返回的是 `Promise<IteratorResult<T, TReturn>>`。

底层机制比同步生成器更复杂：

1. **状态机 + Promise 链**：每次 `yield` 既要保存生成器状态，又要把值包装成 Promise 返回给调用方
2. **`await` 和 `yield` 混用**：函数体里 `await` 点会先挂起等 Promise，再从暂停点继续
3. **next() 调用的串行化**：多次并发 `next()` 会被引擎内部排队，保证顺序一致

关键不变量：**async generator 的 `next()` 调用之间是串行的**。你调了第一次 `next()` 得到 Promise A，在 A resolve 之前就调第二次 `next()`，引擎会把第二次请求挂到队列里等 A 完成。这意味着你**不能用并发调用 `next()` 实现并行取值**。

### 2.4 `yield*` 委托

```ts
async function* inner() {
  yield 1
  yield 2
}

async function* outer() {
  yield 0
  yield* inner()   // 把 inner() 的所有 yield 都透传出去
  yield 3
}
// outer 产出：0, 1, 2, 3
```

`yield*` 做了三件事：
1. 把内部迭代器的每个值透传
2. 把内部迭代器的 `return` 值作为 `yield*` 表达式的值
3. 把外部 `next()` 的参数转发给内部

这在 AgentLoop 里用得密集：

```ts
// agent-loop.ts:236
const llmResult = yield* this.#callLLM(history)   // callLLM 既 yield 事件，又 return 收集结果
```

`#callLLM` 的类型：

```ts
AsyncGenerator<AgentEvent, { toolCalls, text, aborted }>
```

`T = AgentEvent`（yield 的事件流）、`TReturn = { toolCalls, text, aborted }`（聚合结果）。`yield*` 把事件透传给外层消费者，同时把 return 值拿回来赋给 `llmResult`。**这正是为什么内部方法必须标成 `AsyncGenerator` 而不是 `AsyncIterable`** —— `AsyncIterable` 没有 `TReturn`，`yield*` 就拿不到聚合结果了。

---

## 三、类型层级：AsyncGenerator ⊂ AsyncIterator ⊂ AsyncIterable

TypeScript 官方定义（lib.es2018.asynciterable.d.ts / lib.es2018.asyncgenerator.d.ts，简化版）：

```ts
interface AsyncIterable<T> {
  [Symbol.asyncIterator](): AsyncIterator<T>
}

interface AsyncIterator<T, TReturn = any, TNext = unknown> {
  next(...args: [] | [TNext]): Promise<IteratorResult<T, TReturn>>
  return?(value?: TReturn | PromiseLike<TReturn>): Promise<IteratorResult<T, TReturn>>
  throw?(e?: unknown): Promise<IteratorResult<T, TReturn>>
}

interface AsyncGenerator<T = unknown, TReturn = any, TNext = unknown>
  extends AsyncIterator<T, TReturn, TNext> {
  next(...args: [] | [TNext]): Promise<IteratorResult<T, TReturn>>
  return(value: TReturn | PromiseLike<TReturn>): Promise<IteratorResult<T, TReturn>>
  throw(e: unknown): Promise<IteratorResult<T, TReturn>>
  [Symbol.asyncIterator](): AsyncGenerator<T, TReturn, TNext>
}
```

比较一下：

| 能力 | `AsyncIterable<T>` | `AsyncIterator<T>` | `AsyncGenerator<T, TReturn, TNext>` |
|---|---|---|---|
| `[Symbol.asyncIterator]()` | 必须 | 可选（自引用） | 必须（返回自身） |
| `next()` | ✗（需要先拿 iterator） | ✓ | ✓ |
| `return()` | ✗ | 可选（不保证有） | **必有**（非可选） |
| `throw()` | ✗ | 可选 | **必有** |
| `TReturn` 建模 | 无 | 有 | 有 |
| `TNext` 建模 | 无 | 有 | 有 |

**子类型关系**：`AsyncGenerator<T>` 赋值给 `AsyncIterable<T>` 变量合法（upcast），反过来非法（需要 type assertion）。

一句话总结：
- `AsyncIterable` = **"给我迭代器"**（协议）
- `AsyncIterator` = **"让你 `next()`"**（接口，可能来自 class / 闭包 / generator）
- `AsyncGenerator` = **"我是 `async function*` 的产物，你 `next/return/throw` 我都接"**（具体实现的类型）

---

## 四、`async function*` 的运行时魔法

### 4.1 它到底编译成什么？

看一个最小例子：

```ts
async function* demo() {
  yield 1
  await Promise.resolve()
  yield 2
}
```

V8（和 Node）执行时大致长这样：

1. 调用 `demo()` **不执行函数体**，返回一个 `AsyncGenerator` 对象
2. 这个对象内部维护：
   - 当前执行状态（挂起位置的程序计数器）
   - 所有局部变量的快照
   - 一个 Promise 队列（缓冲未消费的 `next()` 请求）
3. 第一次 `next()` 被调用，引擎从函数开头执行，遇到 `yield 1`：
   - 包装成 `Promise.resolve({ value: 1, done: false })`
   - 挂起，保存当前位置
4. 第二次 `next()` 恢复，执行 `await Promise.resolve()`：
   - 这里先挂起等 Promise resolve（异步点）
   - 然后继续到 `yield 2`
   - 再次挂起，返回 `Promise.resolve({ value: 2, done: false })`
5. 第三次 `next()` 恢复，发现函数体结束：
   - 返回 `Promise.resolve({ value: undefined, done: true })`

### 4.2 调度开销

每个 `yield` 会产生：
- **一次 Promise 分配**（微任务调度）
- **一次状态机状态保存**（引擎内部结构）
- **一次 microtask 调度**（把 resolve 推到 microtask 队列）

数量级：在 Node 20 的 V8 上，一次 `yield` 的纯开销大约是 **亚微秒（sub-microsecond）级别**。和网络 IO、文件 IO、LLM 调用相比可以完全忽略。

但是如果你在一个 tight loop 里 yield 几百万次（比如逐字节解析二进制流），开销会显现出来。这时候应该换成一次返回一大块的 Buffered iterator。

### 4.3 `for await...of` 的编译展开

```ts
for await (const x of asyncIter) {
  use(x)
}
```

大致编译成（ES2018 规范步骤简化版）：

```ts
{
  const it = asyncIter[Symbol.asyncIterator]()
  let result: IteratorResult<unknown>
  try {
    while (true) {
      result = await it.next()
      if (result.done) break
      const x = result.value
      use(x)
    }
  } catch (err) {
    // 异常时尝试调用 return() 做清理
    try { await it.return?.() } catch {}
    throw err
  } finally {
    // break / return 退出时也调用 return() 做清理
    if (!result!.done) {
      try { await it.return?.() } catch {}
    }
  }
}
```

这里藏着一个关键行为：**循环体里 `break` 或抛异常时，引擎会自动调用 iterator 的 `return()` 触发清理**。

对 `async function*` 来说，这会让生成器内部的 `finally` 块执行：

```ts
async function* withCleanup() {
  try {
    yield 1
    yield 2   // 消费方 break 后，这里不会执行
    yield 3
  } finally {
    // 但这里会执行！
    await cleanup()
  }
}

for await (const x of withCleanup()) {
  if (x === 1) break   // 触发 return() → finally 执行
}
```

**如果 iterable 只是 `AsyncIterable`（没有 `return()`）**，`for await...of` 退出时就没法触发清理。这是 `AsyncGenerator` 比纯 `AsyncIterable` 多出的一条重要能力，下面会用到。

---

## 五、回到 AgentLoop — 为什么应该改

### 5.1 现状的不一致

`cCli/src/core/agent-loop.ts` 当前签名：

```ts
// Public 入口
async* run(messages: Message[]): AsyncIterable<AgentEvent> { ... }

// 同文件内的私有方法
async* #callLLM(history, ...): AsyncGenerator<AgentEvent, { toolCalls, text, aborted }> { ... }
async* #executeToolCalls(toolCalls, history): AsyncGenerator<AgentEvent> { ... }
async* #executeOneTool(tc, history): AsyncGenerator<AgentEvent> { ... }
async* #checkPermission(tc): AsyncGenerator<AgentEvent, boolean> { ... }
```

内部方法全是 `AsyncGenerator`，唯独 public `run()` 是 `AsyncIterable`。实现本身都是 `async function*`，运行时对象都是 `AsyncGenerator`—— 这个不一致纯粹是类型标注的随意。

### 5.2 `AsyncIterable` 的"损失"

把 `AsyncGenerator` 标成 `AsyncIterable` 是**向上转型**（type widening），三件事被丢失：

1. **`return()` 方法的类型**
   调用方持有 `AsyncIterable<T>` 时，`iter.return()` 在类型检查上不存在。要拿到只能：
   ```ts
   const iter = loop.run(messages)
   const asyncIter = iter[Symbol.asyncIterator]()
   await asyncIter.return?.()   // 要先 asyncIterator() 再 optional chain
   ```
   有了 `AsyncGenerator` 则直接：
   ```ts
   await loop.run(messages).return()   // 直接可用，类型安全
   ```

2. **`throw()` 方法的类型**
   测试或调试时，往生成器注入一个错误验证 error 处理路径的写法：
   ```ts
   const iter = loop.run(messages)
   await iter.next()   // 先推进一次
   await iter.throw(new Error('injected'))   // AsyncIterable 下无此方法
   ```

3. **`TReturn` 的建模**
   `yield* loop.run(messages)` 在 `AsyncIterable` 下得不到 return 值。虽然 `run()` 当前返回 `void`，但未来一旦想改成带 return 值（比如 return 本次会话的 token 使用总结），签名得大改。

### 5.3 调用方现状

grep 了全仓，`run()` 的调用方共 4 处：

| 文件 | 用法 |
|---|---|
| `src/ui/useChat.ts:358` | `for await (const event of loop.run(historyRef))` |
| `src/core/pipe-runner.ts:99` | `for await (const event of loop.run(history))` |
| `src/tools/agent/dispatch-agent.ts:297` | `for await (const event of subLoop.run(initialMessages))` |
| `src/tools/agent/dispatch-agent.ts:573` | `for await (const event of subLoop.run(initialMessages))` |

全部只用 `for await...of`，没人显式调 `return()` / `throw()`。这说明：

- **改成 `AsyncGenerator` 零破坏**（子类型赋值给父类型总是兼容的）
- **改完给了这些调用方额外能力**（未来需要时可以直接用 `.return()` 主动清理）

### 5.4 改造方案

**一行改动**：

```diff
- async* run(messages: Message[]): AsyncIterable<AgentEvent> {
+ async* run(messages: Message[]): AsyncGenerator<AgentEvent, void, unknown> {
```

三个类型参数：
- `T = AgentEvent` — yield 的事件流
- `TReturn = void` — `run()` 所有 `return` 语句都是无值 return
- `TNext = unknown` — 从不消费 `next()` 参数（调用方不会往里传值）

为什么显式写 `void` 和 `unknown` 而不是 `AsyncGenerator<AgentEvent>` 默认？因为 TypeScript 的默认是 `TReturn = any`、`TNext = unknown`，`any` 会污染类型推导。显式 `void` 让编译器在未来有人不小心加了 `return someValue` 时立刻报错。

---

## 六、改完的收益清单

### 6.1 类型正确性与一致性

1. **消除同文件类型标注的随意性**：public 方法和私有方法类型风格一致
2. **反映实现的真实本质**：`async function*` 的产物就是 `AsyncGenerator`，标注该这么写
3. **`void` 比 `any` 更严格**：未来任何人想给 `return` 加值都会被编译器挡下

### 6.2 给调用方的能力（未来可能用到）

1. **主动清理能力**：
   ```ts
   // 假设未来 useChat 需要在用户切换 session 时主动停掉当前 loop
   const iter = loop.run(history)
   // ... 正常消费 ...
   if (userSwitchedSession) {
     await iter.return()   // 触发 run() 里的 finally 块，释放资源
   }
   ```

2. **错误注入（用于测试）**：
   ```ts
   // 测试 LLM 上下文被外部强制中断时的行为
   const iter = loop.run(history)
   await iter.next()
   await iter.throw(new Error('provider connection lost'))
   // 验证 loop 产出正确的 llm_error 事件并终止
   ```

3. **未来 `yield*` 委托友好**：
   ```ts
   // 假设要给 run 套一层事件预处理
   async function* runWithPreprocess(messages) {
     yield* loop.run(messages)   // AsyncGenerator 下可以透传 TReturn
   }
   ```

### 6.3 工程化收益

- **IDE 智能提示更准确**：`.return()` / `.throw()` 直接补全，不用查文档
- **新人上手成本低**：看到 `AsyncGenerator` 就知道是 `async function*` 实现，`AsyncIterable` 看不出来
- **类型测试更精确**：`expectType<AsyncGenerator<AgentEvent>>(loop.run(msgs))` 这类断言更有力

---

## 七、常见误区澄清

### 7.1 "改成 AsyncGenerator 能让代码跑更快吗？"

**不能。** 运行时对象完全不变，改的只是 TypeScript 层面的类型标签。

- `async function*` 返回的对象从声明的第一秒起就是 `AsyncGenerator` 实例
- `AsyncIterable` 是它的一个**类型视图**（通过 upcast 获得）
- 编译后的 JavaScript 一模一样，V8 里的对象也一模一样

类型系统只在编译期工作，运行时不存在。

### 7.2 "既然 AsyncIterable 是父类型，声明成父类型不是更灵活吗？"

要看**灵活性指的是谁的视角**。

- 对**调用方**来说：父类型灵活（能接受更多实现）
- 对**维护者**来说：父类型是**束缚**（未来实现想换成非 generator 的 AsyncIterable 没问题，但丢掉了 `return/throw` 的表达能力）

对 `AgentLoop.run()` 这种**具体业务方法**，实现大概率会一直是 generator，父类型的"灵活"是虚假的，反而损失了类型信息。API 设计的常见原则：**Accept the widest type, return the narrowest type**（入参收最宽的，出参返最窄的）。`AsyncIterable` 做入参合理（比如工具函数 `async function toArray<T>(it: AsyncIterable<T>)`），做出参不合理。

### 7.3 "改这个对 AgentLoop 性能有帮助吗？"

**无。** 如果你想提升 AgentLoop 的速度，找真正的瓶颈：

**按量级排序的优化方向**（都不是改类型标注能解决的）：

1. **LLM 调用时间（占 80%+）**
   - Prompt caching：Anthropic 5 分钟窗口，每轮重复的 history 能省 50-90% 输入 token 延迟
   - 模型路由：简单任务（格式化、工具参数）用 haiku，复杂推理才用 opus
   - Streaming TTFT：已经有采集，看数据找异常长尾

2. **工具执行**
   - 并行度：已有 `executeSafeToolsInParallel`，核对 classification 是否漏掉了应该并行的工具
   - 单个工具超时：避免等满才继续

3. **消息历史裁剪**
   - `summarizeArgs` 只裁了 tool_call args，**tool_result 的大内容**（write_file 完整文件、bash 长输出）没裁，是 token 爆炸的主源
   - 噪声输出（npm install 进度条）应该压成摘要

4. **Generator 开销**（最低优先级）
   - `yield*` 嵌套深度：目前 4 层（run → callLLM/executeToolCalls → executeOneTool → checkPermission），合理
   - 单次 yield 开销亚微秒级，相比 LLM 几百毫秒可忽略

---

## 八、延伸：什么时候真的要用 `AsyncIterable`？

虽然本文推 `AsyncGenerator`，但有场景反而该用 `AsyncIterable`：

### 8.1 做**入参**类型

```ts
// 工具函数：把任何 async iterable 转成数组
async function toArray<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of iter) out.push(x)
  return out
}

// 调用时，所有 AsyncGenerator / Readable Stream / ReadableStream / 手写的 class 都能传
await toArray(someGenerator)
await toArray(process.stdin)
await toArray(fetch(url).then(r => r.body!))
```

入参用最宽的类型，最大化复用。

### 8.2 实现**不是** generator 的 AsyncIterable

有些场景适合手写 class：
- 多个消费者共享同一状态（generator 每次都是新实例，状态独立）
- 和外部资源强绑定（数据库 cursor、网络流）且需要显式生命周期管理
- 性能敏感场景（省掉 generator 状态机开销）

Node.js 的 `Readable` 就是典型：它是 `AsyncIterable` 但不是 `AsyncGenerator`。

### 8.3 对外发布的库 API

```ts
// 库作者 A：希望未来能从 generator 实现切成 class 实现而不破坏兼容
export function events(): AsyncIterable<Event> { ... }
```

这里 `AsyncIterable` 是有意的收缩 —— 故意不承诺 `return/throw`，保留实现替换自由度。

但**内部方法、应用代码**几乎都不需要这种灵活度。

---

## 九、落地清单

回到 `cCli/src/core/agent-loop.ts`：

- [x] `run(messages: Message[]): AsyncIterable<AgentEvent>` → `AsyncGenerator<AgentEvent, void, unknown>`
- [x] 运行 `pnpm typecheck` 确认 4 处调用方无 TS 报错
- [x] 运行 `pnpm test` 确认单元测试全过
- [ ] （可选）新写测试验证 `loop.run().return()` 能触发 finally 块里的清理逻辑

代码 diff：1 行改动 + 新增类型参数注释块（说明改造意图 + 指向本文档位置）。

---

## 十、实际改造记录（2026-04-17）

### 10.1 改造内容

`cCli/src/core/agent-loop.ts:220` 签名修改：

```diff
- async* run(messages: Message[]): AsyncIterable<AgentEvent> {
+ /**
+  * 返回类型说明（2026-04-17 从 AsyncIterable 收紧到 AsyncGenerator）：
+  * - 实现是 async function*，运行时对象天然就是 AsyncGenerator
+  * - 原先标注 AsyncIterable<T> 属于向上转型，丢失了 return()/throw()/TReturn
+  *   的类型信息，且与同文件内部方法的 AsyncGenerator 标注不一致
+  * - 现在显式 TReturn=void、TNext=unknown，让未来误增 return 值会被编译器挡下
+  * - 调用方全部只用 for await...of，改动零破坏
+  *
+  * 详细原理、改造取舍、性能误区：
+  *   docs/experience/20260417150016_AsyncIterable与AsyncGenerator的魔法细节.md
+  */
+ async* run(messages: Message[]): AsyncGenerator<AgentEvent, void, unknown> {
```

### 10.2 类型检查

`pnpm typecheck` 零错误。四处调用方（useChat.ts / pipe-runner.ts / dispatch-agent.ts × 2）
全部只用 `for await...of`，无任何报错。

### 10.3 全量测试对比（3 次取平均）

**测试环境**：Windows 10 + Node.js + pnpm + vitest 4.x，86 个测试文件 / 730 个测试用例。

#### Baseline（改造前）

| 轮次 | Duration | Transform | Import | Tests (并行和) |
|---|---|---|---|---|
| Run 1 | 31.63s | 4.42s | 24.23s | 97.75s |
| Run 2 | 31.64s | 4.01s | 23.68s | 96.26s |
| Run 3 | 31.47s | 4.17s | 23.69s | 93.61s |
| **均值** | **31.58s** | **4.20s** | **23.87s** | **95.87s** |

#### After（改造后）

| 轮次 | Duration | Transform | Import | Tests (并行和) |
|---|---|---|---|---|
| Run 1 | 31.49s | 4.36s | 25.33s | 88.29s |
| Run 2 | 31.49s | 4.06s | 23.87s | 85.60s |
| Run 3 | 31.49s | 4.15s | 24.37s | 94.01s |
| **均值** | **31.49s** | **4.19s** | **24.52s** | **89.30s** |

#### 差异分析

| 指标 | Baseline | After | Δ | Δ% |
|---|---|---|---|---|
| **Duration（wall clock）** | 31.58s | 31.49s | -0.09s | **-0.28%** |
| Transform | 4.20s | 4.19s | -0.01s | -0.24% |
| Import | 23.87s | 24.52s | +0.65s | +2.72% |
| Tests（并行和） | 95.87s | 89.30s | -6.57s | -6.85% |

**测试结果**：`86 passed / 728 passed / 2 skipped`，两次完全一致，**零回归**。

### 10.4 数据解读

1. **Wall clock 基本无差异**：0.09s 的差值远小于 Node.js 冷启动、磁盘缓存、OS 调度这些
   外部噪声的波动幅度。任何单次 run 的波动都能吃掉这个数字。

2. **Import 时间反而略增（+0.65s）**：这反映了**测试框架启动噪声**，和我们的改动无关。
   第二次跑往往因为 OS 页缓存热起来反而更快，但这里没有稳定趋势。

3. **Tests 并行和下降 6.57s**：看起来"改进"最明显，但这是**并行测试时间之和**，
   最终 wall clock 不变说明这只是并发调度的微小再分配，不能归因到类型改动。

4. **结论**：改造**对运行时性能零影响**，数据完全印证了本文第 7.1 节的判断 —
   类型标注只在编译期工作，运行时对象和改前完全一样。

### 10.5 收益实证

虽然性能无变化，改造带来的**类型收益**是真实的：

1. IDE 悬停 `loop.run(...)` 现在显示的类型是 `AsyncGenerator<AgentEvent, void, unknown>`，
   比原先 `AsyncIterable<AgentEvent>` 多出 `next / return / throw` 的补全
2. 同文件 5 个 `async function*` 方法的返回类型现在风格统一，
   新人维护者不再困惑"为什么 run() 特殊"
3. 若未来在 `run()` 里误加 `return someValue`，TypeScript 会立刻报错
   （旧签名下 `TReturn` 走 `any`，静默通过）

### 10.6 Git 历史定位

改造提交见 `git log` 中 `refactor(agent-loop): run() 返回类型...` 相关 commit。
未来若对该函数签名有疑问，可通过：

```bash
git log -p cCli/src/core/agent-loop.ts | grep -A 5 "async\* run"
```

快速定位签名变更历史。

---

## 十、参考

- MDN [Iteration Protocols](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Iteration_protocols)
- MDN [AsyncGenerator](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/AsyncGenerator)
- ECMAScript Spec [Async Iteration](https://tc39.es/ecma262/#sec-asynciterable-interface)
- TypeScript Handbook [Generators](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-2-3.html#generators-and-iteration-for-es5es3)
- V8 博客 [Faster async functions and promises](https://v8.dev/blog/fast-async)

---

## 附录：一张图看懂

```
               ┌──────────────────────────┐
               │   AsyncIterable<T>        │  协议：只要有 [Symbol.asyncIterator]
               │   [Symbol.asyncIterator]  │  - 可被 for await...of 消费
               └────────────▲─────────────┘
                            │ extends
               ┌──────────────────────────┐
               │   AsyncIterator<T>        │  接口：能 next()，可选 return/throw
               │   next() / return?/ throw?│
               └────────────▲─────────────┘
                            │ extends
               ┌──────────────────────────┐
               │ AsyncGenerator<T,R,N>     │  async function* 的产物
               │  next / return / throw    │  完整能力，TReturn + TNext 建模
               │  (非可选)                  │
               └──────────────────────────┘

           upcast (向上转型，合法)：AsyncGenerator → AsyncIterable
           downcast (向下转型，危险)：AsyncIterable → AsyncGenerator (需要运行时验证)
```

---

**作者按**：类型签名这种看似琐碎的事，长期累积下来会显著影响代码的可读性和可演进性。
一个 `async function*` 诚实地标注成 `AsyncGenerator`，不是学究式的强迫症，是让读代码的人
（包括半年后的自己）不用再花时间从实现反推意图。工程的复利效应就藏在这类细节里。
