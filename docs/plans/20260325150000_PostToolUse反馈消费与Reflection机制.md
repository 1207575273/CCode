# PostToolUse 反馈消费与 Reflection 机制

> 日期: 2026-03-25
> 现状: Phase 1 + Phase 2 + Phase 3 均已完成
> Phase 1: PostToolUse 反馈消费 + JSONL 持久化
> Phase 2: verify_code 内置工具（自动检测语言 + 执行检查命令）
> Phase 3: hooks.json 默认模板（初始化自动创建，开箱即用）

---

## 一、问题

LLM 生成代码/执行操作后没有任何验证环节。写了有语法错误的代码、执行了失败的命令，
LLM 看不到反馈，无法自我修正。

具体表现为三个层面：
1. **PostToolUse hook 返回值被丢弃** — hook 脚本跑了但结果进了黑洞（Phase 1 解决）
2. **没有主动验证能力** — LLM 没有可调用的代码检查工具（Phase 2 解决）
3. **没有默认 hooks.json** — Hook 系统需要用户手动写配置才生效（Phase 3 解决）

---

## 二、整体设计：两层 Reflection 体系

```
┌───────────────────────────────────────────────────────────┐
│                  Reflection 体系                           │
│                                                           │
│  ┌─────────────────────────────────┐                      │
│  │  Layer 1: verify_code 工具       │  ← 默认可用          │
│  │  LLM 主动调用，零配置           │     提示词引导         │
│  │  语言自动检测，开箱即用          │     LLM 自主决策       │
│  └─────────────────────────────────┘                      │
│                                                           │
│  ┌─────────────────────────────────┐                      │
│  │  Layer 2: PostToolUse Hooks      │  ← 默认开启          │
│  │  初始化自动创建 hooks.json      │     强制执行           │
│  │  项目级 > 用户级，可自定义      │     自动注入反馈       │
│  └─────────────────────────────────┘                      │
└───────────────────────────────────────────────────────────┘
```

### 两层的关系

| 维度 | verify_code 工具（Layer 1） | PostToolUse Hook（Layer 2） |
|------|---------------------------|---------------------------|
| **定位** | 前台能力，LLM 的"眼睛" | 后台管线，项目的"安全网" |
| **触发者** | LLM 自主决定调用 | 系统自动执行（write_file/edit_file 后） |
| **LLM 感知** | 感知（正常工具调用流） | 不感知（反馈静默注入 history） |
| **配置** | 零配置，注册为内置工具 | 初始化自动创建 hooks.json，用户可自定义 |
| **默认状态** | 默认开启 | **默认开启**（初始化自动创建模板） |
| **检查内容** | 自动检测语言 + 跑对应检查命令 | 默认 TypeScript（tsc）+ Java（mvn/gradle），可自定义任意命令 |
| **结果去向** | 作为工具结果返回给 LLM | 注入 history + yield 事件 + JSONL 持久化 |
| **可编排性** | 强（可被 Plan/SubAgent/流程编排调用） | 弱（固定在工具执行后触发） |
| **适用场景** | 日常开发、主动代码审查 | 强制验证、团队规范、安全审计 |
| **日志持久化** | ✅ tool_call_start + tool_call_end（标准工具事件流） | ✅ post_tool_feedback（独立事件类型） |

### 协作示例

```
场景：用户让 LLM 重构一个 TypeScript 模块

1. LLM 分析代码 → 调用 edit_file 修改文件
   ↓
2. [Layer 2] PostToolUse hook 自动触发（hooks.json 默认规则）
   → 检测到 tsconfig.json → 跑 tsc --noEmit → 发现类型错误
   → 反馈注入 history: "[PostToolUse feedback for edit_file]: TS2345..."
   → yield post_tool_feedback 事件 → SessionLogger 写入 JSONL
   ↓
3. LLM 看到 hook 反馈 → 再次 edit_file 修复类型错误
   ↓
4. [Layer 2] PostToolUse hook 再次触发 → tsc 通过 → 无输出（不注入）
   ↓
5. [Layer 1] LLM 主动调用 verify_code（"改了这么多，我全面验证一下"）
   → 跑 tsc + eslint → 全部通过
   ↓
6. LLM 回复用户："重构完成，已通过类型检查和 lint"
```

---

## 三、Phase 1：PostToolUse 反馈消费【已完成】

### 问题

PostToolUse hook 返回值（`additionalContext` / `userMessage`）被丢弃，
hook 脚本跑了但结果进了黑洞，LLM 无法看到验证反馈。

### 改动

| 文件 | 改动 |
|------|------|
| `src/core/agent-loop.ts` | PostToolUse 返回值消费 + yield `post_tool_feedback` 事件 |
| `src/observability/session-logger.ts` | 新增 `post_tool_feedback` 事件处理 |
| `src/persistence/session-types.ts` | `SessionEventType` 新增 `'post_tool_feedback'` + `feedback` 字段 |

### 数据流

```
工具执行完成
  ↓
history.push(工具结果)           ← LLM 先看到工具结果
  ↓
PostToolUse hook 执行
  ↓ hook 脚本返回 { additionalContext: "tsc error: ..." }
  ↓
history.push(反馈)               ← LLM 再看到验证反馈
yield post_tool_feedback 事件    ← SessionLogger 写入 JSONL
  ↓
下一轮 LLM 调用                  ← LLM 据此自行修正
```

### JSONL 持久化格式

```json
{
  "type": "post_tool_feedback",
  "toolName": "write_file",
  "toolCallId": "tc-123",
  "feedback": "TypeScript check:\nsrc/config.ts(12,5): error TS2345...",
  "timestamp": "2026-03-25T10:30:00.000Z"
}
```

### 向后兼容

- 没有 hookManager → 跳过整段逻辑
- 没有 PostToolUse 规则 → postResults 空数组，for 循环不进入
- hook 无输出或返回无效 JSON → null，被 `if (!r) continue` 过滤
- **对无 hooks.json 的用户零影响**

---

## 四、Phase 2：verify_code 内置工具【已完成】

### 工具定义

```typescript
工具名: verify_code
文件: src/tools/ext/verify-code.ts
分类: ext（扩展工具）
dangerous: false（只读检查，不修改文件）

参数:
  file_path: string       // 要检查的文件路径
  check_type?: string     // 'auto' | 'typescript' | 'javascript' | 'python' | 'rust' | 'go' | 'java'
                          // 默认 'auto'（从文件扩展名 + 项目配置自动推断）
```

### 支持的语言和检查器

| 语言 | 扩展名 | 配置文件检测 | 检查命令 | 超时 |
|------|--------|-------------|---------|------|
| TypeScript | `.ts` `.tsx` | `tsconfig.json` | `npx tsc --noEmit` | 30s |
| JavaScript | `.js` `.jsx` `.mjs` `.cjs` | `.eslintrc.*` / `eslint.config.*` | `npx eslint {file}` | 15s |
| Python | `.py` | `pyproject.toml` / `ruff.toml` / `mypy.ini` | `ruff check` / `mypy` | 10-20s |
| Rust | `.rs` | `Cargo.toml` | `cargo check` | 60s |
| Go | `.go` | `go.mod` | `go vet ./...` | 30s |
| Java | `.java` | `pom.xml` / `build.gradle` / `build.gradle.kts` | `mvn compile -q` / `gradle compileJava -q` | 60s |

### 自动检测策略

```
1. 从 file_path 扩展名推断语言
2. 从文件位置向上最多 10 层查找项目配置文件
3. 配置文件存在 → 启用对应检查器
4. 同语言多个检查器共存 → 全部执行（如 tsc + eslint）
5. 无配置文件 → 返回友好提示，不报错
```

### 输出格式

```
成功：
  ✓ TypeScript: No errors found
  ✓ ESLint: No warnings

失败（截取前 30 行）：
  ✗ TypeScript: errors found
    src/config.ts:12:5 - TS2345: Argument of type 'string'...
    src/config.ts:28:10 - TS7006: Parameter 'x' implicitly...
  ✓ ESLint: No warnings

不支持：
  ⚠ No supported checker found for .md files
  Supported: .ts, .tsx, .js, .jsx, .py, .rs, .go, .java
```

### 可编排性

| 编排方式 | 示例 |
|----------|------|
| **提示词引导** | system prompt: "修改代码后考虑调用 verify_code 检查" |
| **Plan 集成** | todo_write 步骤包含"验证"→ LLM 调用 verify_code |
| **SubAgent** | review 类型子 Agent 工具集包含 verify_code |
| **未来流程编排** | DAG 节点：edit → verify → 条件分支（通过/修复） |

### 改动

| 文件 | 改动 |
|------|------|
| `src/tools/ext/verify-code.ts` | 新增工具实现（~170 行） |
| `src/core/bootstrap.ts` | import + register（2 行） |

---

## 五、Phase 3：hooks.json 默认模板【已完成】

### 问题

Phase 1 打通了 PostToolUse 反馈消费管线，但没有用户会主动创建 hooks.json，
导致 Layer 2 形同虚设。需要在初始化流程中自动创建默认模板。

### 设计

**两级 hooks.json，项目级 > 用户级：**

| 级别 | 路径 | 内容 | 作用 |
|------|------|------|------|
| 项目级 | `项目/.ccode/hooks.json` | 完整默认规则（tsc + mvn/gradle） | 实际生效的检查规则 |
| 用户级 | `~/.ccode/hooks.json` | 空模板 `{ hooks: {} }` | 用户自定义全局规则的入口 |

**为什么不两级都放完整规则？**

bootstrap 加载顺序是 plugin → project → user，三层规则**叠加执行不覆盖**。
如果两级都有相同的 tsc 规则，每次 write_file 后会跑两遍 tsc → 浪费时间。
项目级放完整规则，用户级留空，避免重复。

### 默认模板内容

#### 项目级 `项目/.ccode/hooks.json`（完整规则，实际生效）

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "^(write_file|edit_file)$",
        "hooks": [
          {
            "type": "command",
            "command": "if [ -f tsconfig.json ]; then result=$(npx tsc --noEmit 2>&1 | head -30); if [ -n \"$result\" ]; then echo \"{\\\"additionalContext\\\":\\\"TypeScript check:\\n$result\\\"}\"; fi; fi",
            "timeout": 20000
          },
          {
            "type": "command",
            "command": "if [ -f pom.xml ]; then result=$(mvn compile -q 2>&1 | tail -30); if echo \"$result\" | grep -qi \"error\"; then echo \"{\\\"additionalContext\\\":\\\"Java Maven check:\\n$result\\\"}\"; fi; elif [ -f build.gradle ] || [ -f build.gradle.kts ]; then result=$(gradle compileJava -q 2>&1 | tail -30); if echo \"$result\" | grep -qi \"error\"; then echo \"{\\\"additionalContext\\\":\\\"Java Gradle check:\\n$result\\\"}\"; fi; fi",
            "timeout": 60000
          }
        ]
      }
    ]
  }
}
```

**命令逻辑说明：**

| 检查器 | 命令拆解 | 触发条件 |
|--------|---------|---------|
| TypeScript | `if [ -f tsconfig.json ]` → `npx tsc --noEmit` → 取前 30 行 → 有输出才返回 JSON | 项目有 tsconfig.json |
| Java Maven | `if [ -f pom.xml ]` → `mvn compile -q` → 取后 30 行 → grep 到 error 才返回 JSON | 项目有 pom.xml |
| Java Gradle | `elif [ -f build.gradle ]` → `gradle compileJava -q` → 取后 30 行 → grep 到 error 才返回 JSON | 项目有 build.gradle 或 build.gradle.kts |

**关键设计**：命令先检测配置文件是否存在，不存在则静默跳过。非 TS/Java 项目**零开销**。

#### 用户级 `~/.ccode/hooks.json`（空模板，避免重复执行）

```json
{
  "hooks": {}
}
```

用户想添加**所有项目都生效**的全局规则时，手动编辑此文件。例如添加 Python 检查：

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "^(write_file|edit_file)$",
        "hooks": [
          {
            "type": "command",
            "command": "if [ -f pyproject.toml ]; then result=$(ruff check . 2>&1 | head -20); if [ -n \"$result\" ]; then echo \"{\\\"additionalContext\\\":\\\"Ruff check:\\n$result\\\"}\"; fi; fi",
            "timeout": 10000
          }
        ]
      }
    ]
  }
}
```

### 初始化流程

```
initialize()（CLI 启动最早期，src/core/initializer.ts）
  ↓
1. 确保 ~/.ccode/ 目录存在
2. 确保 config.json 存在
3. 确保 .mcp.json 存在
4. 确保 项目/.ccode/settings.local.json 存在
5. 确保 项目/.ccode/hooks.json 存在        ← 完整默认规则
   确保 ~/.ccode/hooks.json 存在            ← 空模板
6. 启动诊断
```

**幂等性**：已存在的 hooks.json 不会被覆盖。用户修改过的配置不受影响。

### 如何修改默认初始化模板

默认模板定义在 **`src/core/initializer.ts`** 的 `DEFAULT_HOOKS_CONFIG` 常量中。
要新增语言支持或修改默认检查命令，修改该常量即可：

```
文件：src/core/initializer.ts
常量：DEFAULT_HOOKS_CONFIG（约第 55 行）
影响：新项目首次初始化时创建的 hooks.json 内容
注意：已存在的 hooks.json 不会被覆盖，只影响新项目
```

### 改动

| 文件 | 改动 |
|------|------|
| `src/core/initializer.ts` | 新增 `DEFAULT_HOOKS_CONFIG` 模板 + 初始化流程创建两级 hooks.json |

---

## 六、完整 Reflection 架构（Phase 1 + 2 + 3 协作全景）

```
┌──────────────────────────────────────────────────────────────┐
│                      CLI 启动                                 │
│  initializer.ts → 自动创建 hooks.json（项目级完整/用户级空）  │
│  bootstrap.ts → hookManager 加载 hooks.json 规则              │
│  bootstrap.ts → verify_code 注册为内置工具                    │
└──────────────────────────────────┬───────────────────────────┘
                                   ↓
┌──────────────────────────────────────────────────────────────┐
│                      Agent 执行循环                           │
│                                                               │
│  LLM 调用工具（write_file / edit_file / bash）                │
│    ↓                                                          │
│  工具执行 → history.push(工具结果)                             │
│    ↓                                                          │
│  ┌──────────────────────────────────────────────────┐        │
│  │  [Layer 2] PostToolUse Hook 自动触发              │        │
│  │  hooks.json matcher: ^(write_file|edit_file)$     │        │
│  │                                                    │        │
│  │  TypeScript 项目 → tsc --noEmit                   │        │
│  │  Java 项目 → mvn compile -q / gradle compileJava  │        │
│  │  其他项目 → 检测不到配置文件，静默跳过             │        │
│  │                                                    │        │
│  │  有错误:                                           │        │
│  │    history.push("[PostToolUse feedback]: TS2345...") │       │
│  │    yield post_tool_feedback → JSONL 持久化          │       │
│  │  无错误:                                           │        │
│  │    不输出，不注入，零影响                           │        │
│  └──────────────────────────────────────────────────┘        │
│    ↓                                                          │
│  LLM 看到工具结果 + hook 反馈（如有）                         │
│    ↓                                                          │
│  LLM 决策：需要主动验证？                                     │
│    ├── 是 → 调用 verify_code(file_path)  [Layer 1]           │
│    │        → 自动检测语言 → 跑全部可用检查器                 │
│    │        → 返回诊断结果 → LLM 据此修复 → 再 verify        │
│    │                                                          │
│    └── 否 → 继续下一步 / 回复用户                            │
└──────────────────────────────────────────────────────────────┘
```

---

## 七、设计决策记录

### 为什么需要两层？

| 只有一层的问题 | 两层配合的解决方案 |
|---------------|-------------------|
| 只有 Hook → LLM 没有主动验证能力 | Layer 1 给 LLM 主动调用的工具 |
| 只有工具 → LLM 可能忘记调用 | Layer 2 在后台强制自动执行 |
| 只有 Hook → 高级功能，普通用户不会配 | Phase 3 自动创建默认模板，开箱即用 |
| 只有工具 → 无法强制团队规范 | Layer 2 支持项目级强制检查规则 |

### 为什么 verify_code 不自动触发？

1. **不是所有写入都需要验证**：README.md、.gitignore、配置文件 → 跑 tsc 无意义
2. **增加延迟**：每次写文件多一次工具调用
3. **LLM 有判断力**：它知道"改了类型定义应该验证" vs "加了注释不用验证"
4. **ReAct 原则**：LLM 自主决策行动，系统不替它决定

Hook（Layer 2）是系统级强制检查，verify_code（Layer 1）是 LLM 级智能验证，两者互不替代。

### hooks.json 两级策略

| 级别 | 路径 | 内容 | 覆盖场景 |
|------|------|------|----------|
| 项目级 | `项目/.ccode/hooks.json` | 完整规则（tsc + Java） | 本项目的检查规则 |
| 用户级 | `~/.ccode/hooks.json` | 空模板 | 用户跨项目的全局规则（需手动配置） |

- bootstrap 加载顺序：plugin → project → user，规则叠加执行
- 项目级有规则 + 用户级空 = 只执行项目级规则（不重复）
- 用户想加全局规则 → 编辑 `~/.ccode/hooks.json`，所有项目生效
- 用户想关掉某项目的检查 → 编辑 `项目/.ccode/hooks.json` 删除对应规则

---

## 八、改动文件汇总

| Phase | 文件 | 改动 |
|-------|------|------|
| 1 | `src/core/agent-loop.ts` | PostToolUse 返回值消费 + yield post_tool_feedback + AgentEvent 新增类型 |
| 1 | `src/observability/session-logger.ts` | 新增 post_tool_feedback 事件处理 |
| 1 | `src/persistence/session-types.ts` | SessionEventType + feedback 字段 |
| 2 | `src/tools/ext/verify-code.ts` | 新增 verify_code 工具（6 语言 + 自动检测） |
| 2 | `src/core/bootstrap.ts` | 注册 VerifyCodeTool |
| 3 | `src/core/initializer.ts` | DEFAULT_HOOKS_CONFIG 模板 + 初始化创建两级 hooks.json |
| 测试 | `tests/unit/tool-verify-code.test.ts` | verify_code 工具 9 个单元测试 |

---

## 九、测试覆盖

### verify_code 工具测试（`tests/unit/tool-verify-code.test.ts`，9 个用例）

| 测试 | 验证内容 |
|------|----------|
| 工具名和 dangerous 属性 | `name === 'verify_code'`，`dangerous === false` |
| 空 file_path | 返回 `success: false`，error 含 file_path |
| 不存在的文件 | 返回 `success: false`，error 含"不存在" |
| 不支持的文件类型（.md） | 返回 `success: true` + 友好提示"No supported checker" |
| 无项目配置文件（.ts 但无 tsconfig） | 返回 `success: true` + 提示"No project config" |
| TypeScript 合法代码 | 创建 tsconfig.json + 合法 .ts → tsc 通过 |
| TypeScript 类型错误 | 创建 tsconfig.json + 错误 .ts → `success: false`，输出含 error |
| 显式 check_type 参数 | 手动指定 python，无 pyproject.toml → 友好降级 |
| 相对路径解析 | 相对路径基于 cwd 正确拼接，不报"不存在" |

### 手动验证方式

**验证 PostToolUse hook（Layer 2）**：
```
1. 确认项目 .ccode/hooks.json 存在且有默认规则
2. 启动 ccli，让 LLM 写一个有类型错误的 TypeScript 文件
3. 观察 LLM 是否在下一轮主动修复错误（说明 tsc 诊断已注入 history）
4. 检查 JSONL 中是否有 post_tool_feedback 事件
```

**验证 verify_code 工具（Layer 1）**：
```
1. 启动 ccli，输入：请对 cCli/src/core/agent-loop.ts 调用 verify_code 检查
2. 观察工具输出是否包含 TypeScript 诊断结果
3. 或输入：请用 verify_code 检查 xxx.java（Java 项目）
```
