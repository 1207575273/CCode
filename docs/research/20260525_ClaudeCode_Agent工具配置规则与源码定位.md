# Claude Code 自定义 Agent 的 tools 字段规则（带源码定位）

> 写作日期: 2026-05-25
> 源码版本: `D:\a_dev_work\claude_cli_z01\a_res\claude-code-main\claude-code-main\`
> 适用范围: 在 `.claude/agents/*.md` 或 `agents.json` 里给自定义 agent 配 `tools` 字段时，应该写什么名字。

---

## 0. 一句话结论

**`tools` 字段里的每一项，必须等于工具的 `name` 字段精确值 —— 都是短名（`Bash` / `Read` / `Grep` / `Edit` ...），不是类名（`BashTool` / `FileReadTool` ...），也不查 `aliases`（写 `Task` 不通，要写 `Agent`）。**

源码定论: `src/tools/AgentTool/agentToolUtils.ts:175-216` 的 `resolveAgentTools()`，用 `availableToolMap.get(toolName)` 只查 `tool.name`，不调用 `toolMatchesName`，aliases 不生效。

---

## 1. 用户实际案例验证

输入:

```
tools: [Read, Grep, Glob, Bash, Write, Edit, MultiEdit, Skill, TodoWrite]
```

逐项对账:

| 你写的 | 源码常量 | name 真值 | 结果 | 备注 |
|---|---|---|---|---|
| `Read` | `FILE_READ_TOOL_NAME` | `Read` | [PASS] | `src/tools/FileReadTool/prompt.ts:5` |
| `Grep` | `GREP_TOOL_NAME` | `Grep` | [PASS] | `src/tools/GrepTool/prompt.ts:4` |
| `Glob` | `GLOB_TOOL_NAME` | `Glob` | [PASS] | `src/tools/GlobTool/prompt.ts:1` |
| `Bash` | `BASH_TOOL_NAME` | `Bash` | [PASS] | `src/tools/BashTool/toolName.ts:2` |
| `Write` | `FILE_WRITE_TOOL_NAME` | `Write` | [PASS] | `src/tools/FileWriteTool/prompt.ts:3` |
| `Edit` | `FILE_EDIT_TOOL_NAME` | `Edit` | [PASS] | `src/constants/...`（见 §3） |
| **`MultiEdit`** | —— | **不存在** | **[FAIL]** | 全仓只在 `src/bridge/sessionRunner.ts:74` 留有兼容显示映射，**不是真实注册工具** |
| `Skill` | `SKILL_TOOL_NAME` | `Skill` | [PASS] | `src/tools/SkillTool/...` |
| `TodoWrite` | `TODO_WRITE_TOOL_NAME` | `TodoWrite` | [PASS] | `src/tools/TodoWriteTool/TodoWriteTool.ts:32` |

**修正建议**:

```yaml
tools: [Read, Grep, Glob, Bash, Write, Edit, Skill, TodoWrite]
```

`MultiEdit` 早期是独立工具，**已合并进 `Edit`（FileEditTool）**，现版本 `Edit` 自身支持单文件多处替换。传 `MultiEdit` 进 `resolveAgentTools()` 会落进 `invalidTools` 数组，被静默忽略。

---

## 2. 完整工具名清单（按主名，带源码定位）

### 2.1 默认池（无条件加载）—— `src/tools.ts:193 getAllBaseTools()`

| name | 源码常量 | 定义位置 |
|---|---|---|
| `Agent` | `AGENT_TOOL_NAME` | `src/tools/AgentTool/constants.ts` |
| `TaskOutput` | `TASK_OUTPUT_TOOL_NAME` | `src/tools/TaskOutputTool/...` |
| `Bash` | `BASH_TOOL_NAME` | `src/tools/BashTool/toolName.ts:2` |
| `Glob` | `GLOB_TOOL_NAME` | `src/tools/GlobTool/prompt.ts:1` （未内嵌 bfs 时） |
| `Grep` | `GREP_TOOL_NAME` | `src/tools/GrepTool/prompt.ts:4` （未内嵌 ugrep 时） |
| `ExitPlanMode` | `EXIT_PLAN_MODE_V2_TOOL_NAME` | `src/tools/ExitPlanModeTool/constants.ts` |
| `Read` | `FILE_READ_TOOL_NAME` | `src/tools/FileReadTool/prompt.ts:5` |
| `Edit` | `FILE_EDIT_TOOL_NAME` | `src/tools/FileEditTool/constants.ts` |
| `Write` | `FILE_WRITE_TOOL_NAME` | `src/tools/FileWriteTool/prompt.ts:3` |
| `NotebookEdit` | `NOTEBOOK_EDIT_TOOL_NAME` | `src/tools/NotebookEditTool/...` |
| `WebFetch` | `WEB_FETCH_TOOL_NAME` | `src/tools/WebFetchTool/prompt.ts:1` |
| `TodoWrite` | `TODO_WRITE_TOOL_NAME` | `src/tools/TodoWriteTool/TodoWriteTool.ts:32` |
| `WebSearch` | `WEB_SEARCH_TOOL_NAME` | `src/tools/WebSearchTool/prompt.ts:3` |
| `TaskStop` | `TASK_STOP_TOOL_NAME` | `src/tools/TaskStopTool/TaskStopTool.ts:40` |
| `AskUserQuestion` | `ASK_USER_QUESTION_TOOL_NAME` | `src/tools/AskUserQuestionTool/prompt.ts:3` |
| `Skill` | `SKILL_TOOL_NAME` | `src/tools/SkillTool/SkillTool.ts:332` |
| `EnterPlanMode` | `ENTER_PLAN_MODE_TOOL_NAME` | `src/tools/EnterPlanModeTool/EnterPlanModeTool.ts:37` |
| `SendUserMessage` | `BRIEF_TOOL_NAME` | `src/tools/BriefTool/prompt.ts:1`（aliases: `Brief`） |
| `SendMessage` | `SEND_MESSAGE_TOOL_NAME` | `src/tools/SendMessageTool/...` |
| `ListMcpResources` | `LIST_MCP_RESOURCES_TOOL_NAME` | `src/tools/ListMcpResourcesTool/...` |
| `ReadMcpResource` | —— | `src/tools/ReadMcpResourceTool/ReadMcpResourceTool.ts:60` (硬编码 `'ReadMcpResourceTool'`) |

### 2.2 按 feature flag / 环境变量 条件加载

| name | 触发开关 | 注册行 |
|---|---|---|
| `ToolSearch` | `isToolSearchEnabledOptimistic()` | `src/tools.ts:249` |
| `TaskCreate` / `TaskGet` / `TaskUpdate` / `TaskList` | `isTodoV2Enabled()` | `src/tools.ts:218-220` |
| `EnterWorktree` / `ExitWorktree` | `isWorktreeModeEnabled()` | `src/tools.ts:225` |
| `LSP` | `ENABLE_LSP_TOOL=true` | `src/tools.ts:224` |
| `PowerShell` | `isPowerShellToolEnabled()` (Windows 启用) | `src/tools.ts:242` |
| `Sleep` | `feature('PROACTIVE')` 或 `KAIROS` | `src/tools.ts:25-28` |
| `CronCreate` / `CronDelete` / `CronList` | `feature('AGENT_TRIGGERS')` | `src/tools.ts:29-35` |
| `RemoteTrigger` | `feature('AGENT_TRIGGERS_REMOTE')` | `src/tools.ts:36-38` |
| `Monitor` | `feature('MONITOR_TOOL')` | `src/tools.ts:39-41` |
| `PushNotification` | `feature('KAIROS')` 或 `KAIROS_PUSH_NOTIFICATION` | `src/tools.ts:45-49` |
| `SubscribePR` | `feature('KAIROS_GITHUB_WEBHOOKS')` | `src/tools.ts:50-52` |
| `SendUserFile` | `feature('KAIROS')` | `src/tools.ts:42-44` |
| `WebBrowser` | `feature('WEB_BROWSER_TOOL')` | `src/tools.ts:117-119` |
| `CtxInspect` | `feature('CONTEXT_COLLAPSE')` | `src/tools.ts:110-112` |
| `TerminalCapture` | `feature('TERMINAL_PANEL')` | `src/tools.ts:113-116` |
| `Snip` | `feature('HISTORY_SNIP')` | `src/tools.ts:123-125` |
| `Workflow` | `feature('WORKFLOW_SCRIPTS')` | `src/tools.ts:129-134` |
| `ListPeers` | `feature('UDS_INBOX')` | `src/tools.ts:126-128` |
| `TeamCreate` / `TeamDelete` | `isAgentSwarmsEnabled()` | `src/tools.ts:228-230` |
| `VerifyPlanExecution` | `CLAUDE_CODE_VERIFY_PLAN=true` | `src/tools.ts:91-95` |
| `OverflowTest` | `feature('OVERFLOW_TEST_TOOL')` | `src/tools.ts:107-109` |

### 2.3 Anthropic 内部（`USER_TYPE === 'ant'`）

| name | 来源 |
|---|---|
| `Config` | `CONFIG_TOOL_NAME` `src/tools/ConfigTool/...` |
| `Tungsten` | `src/tools/TungstenTool/...` |
| `SuggestBackgroundPR` | `src/tools/SuggestBackgroundPRTool/...` |
| `REPL` | `REPL_TOOL_NAME = 'REPL'` `src/tools/REPLTool/constants.ts` |

### 2.4 特殊用途（不进入默认 base 池）

- `SyntheticOutputTool` —— 合成输出占位，被 `getTools()` 在 `src/tools.ts:301-307` 显式从 `specialTools` 集合里剔除
- `TestingPermissionTool` —— 仅 `NODE_ENV === 'test'` 加载
- `MCPTool` / `McpAuthTool` —— MCP 协议基础工具，不在 `getAllBaseTools()`，由 MCP 装配链注入

### 2.5 简易模式 `CLAUDE_CODE_SIMPLE=1`

仅 3 个：`Bash`、`Read`、`Edit`。REPL 模式下退化为 `REPL` 一个。Coordinator 模式额外加 `Agent` + `TaskStop` + `SendMessage`。
源码: `src/tools.ts:271-298 getTools()` 顶部分支。

---

## 3. 自定义 Agent 的 tools 字段解析链路

下面这条链路把 `agents/foo.md` frontmatter 的 `tools:` 一路解析到工具实例，按顺序逐步贴源码。**自查这条路径就能彻底搞懂规则。**

### 3.1 入口：agent 定义文件加载

- 文件：`src/tools/AgentTool/loadAgentsDir.ts:73-99`
- 关键：`AgentJsonSchema` 用 `z.object({ tools: z.array(z.string()).optional(), ... })`，**允许字符串数组或缺省**。

```ts
// loadAgentsDir.ts:76
tools: z.array(z.string()).optional(),
```

Markdown frontmatter 走 `parseAgentToolsFromFrontmatter` 解析（接受字符串、数组、`*`），见下一步。

### 3.2 Frontmatter -> 字符串数组

- 文件：`src/utils/markdownConfigLoader.ts:108-126`
- 函数：`parseAgentToolsFromFrontmatter(toolsValue)`
- 规则：
  - 缺省 -> `undefined`（表示**全部工具**）
  - 空字段 -> `[]`（**没有工具**）
  - 含 `*` -> `undefined`（全部）
  - 其他 -> 用 `parseToolListString` 归一为 `string[]`

### 3.3 字符串切分（支持逗号、空格、括号保留）

- 文件：`src/utils/permissions/permissionSetup.ts:813-859`
- 函数：`parseToolListFromCLI(tools: string[])`
- 规则：逗号 / 空格分隔；**括号内的逗号/空格不切**（用于权限模式 `Bash(git:*)`）。

合法写法举例:

```yaml
tools: ["Read, Grep, Glob"]              # 单字符串 + 逗号
tools: [Read, Grep, Glob]                # 数组
tools: ["Bash(git:*)", "Read", "Edit"]   # 带权限模式（括号内不切）
tools: ["*"]                             # 全开
# 不写 tools 字段也等于全开
```

### 3.4 拆出 toolName 和 ruleContent

- 文件：`src/utils/permissions/permissionRuleParser.ts`
- 函数：`permissionRuleValueFromString(toolSpec)`
- 作用：把 `Bash(git:*)` 拆成 `{ toolName: 'Bash', ruleContent: 'git:*' }`。`toolName` 用于工具查找，`ruleContent` 进入权限层。

### 3.5 核心匹配（重点：只认 name，不认 aliases）

- 文件：`src/tools/AgentTool/agentToolUtils.ts:122-225`
- 函数：`resolveAgentTools(agentDefinition, availableTools, isAsync, isMainThread)`

关键代码（`agentToolUtils.ts:175-216`）:

```ts
const availableToolMap = new Map<string, Tool>()
for (const tool of allowedAvailableTools) {
  availableToolMap.set(tool.name, tool)   // [!] 只按 tool.name 建索引
}

const validTools: string[] = []
const invalidTools: string[] = []
const resolved: Tool[] = []

for (const toolSpec of agentTools) {
  const { toolName, ruleContent } = permissionRuleValueFromString(toolSpec)

  // ... Agent 工具的 allowedAgentTypes 特殊处理 ...

  const tool = availableToolMap.get(toolName)   // [!] 精确查 name，不走 alias
  if (tool) {
    validTools.push(toolSpec)
    if (!resolvedToolsSet.has(tool)) {
      resolved.push(tool)
      resolvedToolsSet.add(tool)
    }
  } else {
    invalidTools.push(toolSpec)                 // 找不到就静默落进 invalid
  }
}
```

**注意对比**：同模块还有 `toolMatchesName()`（`src/Tool.ts:348-353`）这个函数**会查 aliases**，但 `resolveAgentTools` 没用它，所以 agent 配置层 alias **不生效**。

```ts
// src/Tool.ts:348-353  这个函数 agent 配置不调用
export function toolMatchesName(
  tool: { name: string; aliases?: string[] },
  name: string,
): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false)
}
```

### 3.6 sub-agent 工具过滤（叠加在上一步之前）

- 文件：`src/tools/AgentTool/agentToolUtils.ts:70-116`
- 函数：`filterToolsForAgent({ tools, isBuiltIn, isAsync, permissionMode })`
- 黑名单常量：`src/constants/tools.ts` 的 `ALL_AGENT_DISALLOWED_TOOLS` / `CUSTOM_AGENT_DISALLOWED_TOOLS` / `ASYNC_AGENT_ALLOWED_TOOLS`

规则：
- 名字以 `mcp__` 开头的 MCP 工具 -> 一律放行
- `ALL_AGENT_DISALLOWED_TOOLS` 里的 -> 所有 sub-agent 都不可用
- `!isBuiltIn && CUSTOM_AGENT_DISALLOWED_TOOLS` 命中 -> 自定义 agent 不可用（内置 agent 不卡）
- 异步 agent 仅放行 `ASYNC_AGENT_ALLOWED_TOOLS` 集合
- 计划模式下 `ExitPlanMode` 例外放行

**踩坑**：你以为给 sub-agent 配了 `tools: [Agent]` 它就能再开子代理，实际多数情况会被 `CUSTOM_AGENT_DISALLOWED_TOOLS` 卡掉。具体查 `src/constants/tools.ts` 的黑名单。

---

## 4. 踩坑速查

| 踩法 | 现象 | 正确写法 |
|---|---|---|
| 写 `BashTool` / `FileReadTool` 这种类名 | 静默忽略，工具不可用 | 写短名 `Bash` / `Read` |
| 写 `bash` / `READ` 大小写不一致 | 静默忽略 | 严格匹配 `Bash` / `Read` |
| 写 `MultiEdit` | 静默忽略 | 写 `Edit`（已合并） |
| 写 `Task` 想用 Agent 工具 | 静默忽略（`Task` 是 alias，不查） | 写 `Agent` |
| 写 `Brief` 想用消息工具 | 静默忽略（`Brief` 是 alias） | 写 `SendUserMessage` |
| 漏写 `tools` 字段 | **不是没工具，是全开** | 想限工具必须显式写 |
| 写 `tools: []`（空数组） | **真的没工具** | 想全开写 `*` 或漏掉字段 |
| 想给 sub-agent 派子代理 | 被 `CUSTOM_AGENT_DISALLOWED_TOOLS` 卡 | 查 `src/constants/tools.ts` 确认黑名单 |
| `Bash(git:*)` 写成 `Bash (git:*)` 中间带空格 | 切分器把 `Bash` 当一个工具，`(git:*)` 当另一个 | 不要加空格，紧贴写 |

---

## 5. 自查命令（在源码根目录跑）

源码根：`D:\a_dev_work\claude_cli_z01\a_res\claude-code-main\claude-code-main\`

```bash
# 查所有工具的 name 字段真值
grep -rhn "^export const \w*_TOOL_NAME\s*=" src/tools/ src/constants/ | sort -u

# 查所有工具的 name 引用位置
grep -rn "^\s*name:\s*\w*_TOOL_NAME" src/tools/

# 查 agent 工具解析核心
cat src/tools/AgentTool/agentToolUtils.ts | sed -n '70,225p'

# 查工具注册中心（看一眼就懂全貌）
cat src/tools.ts | sed -n '193,251p'

# 查 sub-agent 黑名单
grep -n "ALL_AGENT_DISALLOWED_TOOLS\|CUSTOM_AGENT_DISALLOWED_TOOLS\|ASYNC_AGENT_ALLOWED_TOOLS" src/constants/tools.ts

# 查 frontmatter 解析
grep -n "parseAgentToolsFromFrontmatter\|parseToolListFromCLI" src/utils/

# 验证某个名字是否真实存在（替换 Bash 为目标）
grep -rn "_TOOL_NAME\s*=\s*['\"]Bash['\"]" src/
```

---

## 6. 推荐的 agent 配置模板

只读 / 调研型 agent:

```yaml
---
name: explorer
description: 只读探索 agent
tools: [Read, Grep, Glob, Bash, WebFetch, WebSearch]
---
```

实现型 agent:

```yaml
---
name: implementer
description: 实现型 agent
tools: [Read, Grep, Glob, Bash, Edit, Write, NotebookEdit, TodoWrite, Skill]
---
```

带子任务派发的 agent（注意是否被 `CUSTOM_AGENT_DISALLOWED_TOOLS` 拦）:

```yaml
---
name: orchestrator
description: 编排 agent
tools: [Read, Grep, Glob, Bash, Edit, Write, TodoWrite, Agent, TaskStop, TaskOutput]
---
```

全开（开发期调试用）:

```yaml
---
name: god-mode
description: 全工具开放
# tools 字段省略 = *，等于全开
---
```

---

## 7. 单一真源（Single Source of Truth）速记

| 关注点 | 文件 | 行号 |
|---|---|---|
| 工具注册中心 | `src/tools.ts` | `getAllBaseTools()` :193 |
| 工具组装（含 MCP） | `src/tools.ts` | `assembleToolPool()` :345 |
| agent 工具解析 | `src/tools/AgentTool/agentToolUtils.ts` | `resolveAgentTools()` :122 |
| sub-agent 工具过滤 | `src/tools/AgentTool/agentToolUtils.ts` | `filterToolsForAgent()` :70 |
| name vs alias 匹配 | `src/Tool.ts` | `toolMatchesName()` :348 |
| sub-agent 黑名单 | `src/constants/tools.ts` | `ALL_AGENT_DISALLOWED_TOOLS` 等 |
| Markdown frontmatter 解析 | `src/utils/markdownConfigLoader.ts` | `parseAgentToolsFromFrontmatter()` :113 |
| 字符串切分 | `src/utils/permissions/permissionSetup.ts` | `parseToolListFromCLI()` :813 |
| 权限规则拆分 | `src/utils/permissions/permissionRuleParser.ts` | `permissionRuleValueFromString()` |
