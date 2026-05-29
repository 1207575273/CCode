# Claude Code v2.1.145 工具清单 —— 二进制实测版

> 写作日期: 2026-05-25
> 数据源: 本机 pnpm 安装的官方 release 版二进制 + SDK 声明文件
> 二进制路径: `D:\Program_dev\nodejs\node_modules\@anthropic-ai\claude-code\bin\claude.exe` (219 MB, Bun 编译 PE32+)
> 类型声明: `D:\Program_dev\nodejs\node_modules\@anthropic-ai\claude-code\sdk-tools.d.ts`
> 版本: `@anthropic-ai/claude-code@2.1.145`
> 配套上一篇: [`20260525_ClaudeCode_Agent工具配置规则与源码定位.md`](20260525_ClaudeCode_Agent工具配置规则与源码定位.md)

---

## 0. 为什么要做这次实测

上一篇的工具清单基于 `a_res/claude-code-main/` 源码副本，那是 Anthropic 内部未发布版本快照，**与 npm 上的 release 版有差异**：
- release 版被 Bun tree-shake 掉了大量 internal feature
- 部分工具被重命名 / 合并
- 部分工具是新增的（源码副本里没有）

直接逆向本机装的 v2.1.145 二进制，得到的才是**你日常用的 ccode 真实工具集**。

### 0.1 npm/pnpm 安装包结构（v2.x）

无论用 npm / pnpm / yarn 装的都是同一个 npm 包，结构如下:

```
@anthropic-ai/claude-code/                                # 主包（wrapper）
├── bin/claude.exe                                        # postinstall 时从平台子包复制过来的二进制
├── cli-wrapper.cjs                                       # Node fallback（postinstall 失败时手动跑）
├── install.cjs                                           # postinstall：选平台 + 复制二进制
├── sdk-tools.d.ts                                        # SDK 工具类型声明（明文 TS）
├── package.json                                          # optionalDependencies 列了 12 个平台子包
└── node_modules/@anthropic-ai/
    └── claude-code-win32-x64/                            # 平台子包（按你的 OS+arch 装）
        └── claude.exe                                    # 真正的 Bun 编译二进制
```

`cli-wrapper.cjs:19-50` 的 `PLATFORMS` 表列了 12 个平台：darwin-arm64/x64、linux-x64/arm64/musl/android、freebsd-x64/arm64、win32-x64/arm64。

**关键事实**：v2.x 没有"散装 JS 源码"可直接读，必须逆向二进制。
**老版本（v0.2.x ~ v1.x 早期）** 可能是 minified `cli.js`（用 `npm i @anthropic-ai/claude-code@0.2.9 --ignore-scripts` 装一份试），可以用 `webcrack` / `wakaru` 反混淆，但仍是 minified JS 不是真 TS 源码。真 TS 源码（`a_res/claude-code-main/` 那种）Anthropic 没开源，是内部泄露/分享出来的快照。

---

## 1. 逆向方法详解

### 1.1 关键认知：为什么 Bun 编译的二进制能直接 grep

Claude Code v2.x 用 [Bun build --compile](https://bun.sh/docs/bundler/executables) 把 JS bundle 嵌入一个 standalone runtime PE/ELF/Mach-O 里。**Bun 默认不混淆、不加密源码**，整个 bundle 以**未压缩的 UTF-8 文本**塞在二进制的某个数据段里。所以：

- 所有 `name:` 字段、`description:` 字段、`aliases:` 数组、模板字符串 prompt 都是**明文**
- 变量名经过 esbuild 的 minify（`var DO6 = ...`、`var AU6 = ...`），但**字面量字符串都保留原貌**
- 直接对二进制做字节级 ASCII 提取就能拿到所有 string literal

这就是为什么 `node extract-claude-tools.mjs` 跑一遍就能扫出 30 万 + 字符串、44 个工具名 —— 不需要反编译工具。

### 1.2 逆向的目标文件（精确位置）

| 文件 | 路径 | 大小 | 类型 | 用途 |
|---|---|---|---|---|
| **主逆向目标** | `D:\Program_dev\nodejs\node_modules\@anthropic-ai\claude-code\node_modules\@anthropic-ai\claude-code-win32-x64\claude.exe` | 219 MB | PE32+ x86-64 | Bun 编译的 Windows 二进制，含完整 JS bundle |
| 占位拷贝 | `D:\Program_dev\nodejs\node_modules\@anthropic-ai\claude-code\bin\claude.exe` | 219 MB | 同上（postinstall 时从平台子包 cp 过来） | 实际执行入口（`claude` 命令解析到这里） |
| SDK 类型声明 | `D:\Program_dev\nodejs\node_modules\@anthropic-ai\claude-code\sdk-tools.d.ts` | 2853 行 | 明文 TypeScript | json-schema-to-typescript 生成，含所有工具的 Input/Output 类型 |
| Wrapper | `D:\Program_dev\nodejs\node_modules\@anthropic-ai\claude-code\cli-wrapper.cjs` | 152 行 | 明文 JavaScript | 平台检测 + 退化执行路径 |
| Postinstall | `D:\Program_dev\nodejs\node_modules\@anthropic-ai\claude-code\install.cjs` | 明文 JavaScript | 装包时把对应平台二进制 cp 到 `bin/claude.exe` |

> Mac/Linux 用户对应的二进制路径替换 `claude-code-win32-x64` 为 `claude-code-darwin-arm64` / `claude-code-linux-x64` 等。

### 1.3 用到的脚本（全部 Node.js 原生，无依赖）

| 脚本 | 路径 | 作用 |
|---|---|---|
| 字符串扫描 | `D:\a_dev_work\scripts\extract-claude-tools.mjs` | 字节级提取所有长度 ≥4 的 ASCII 子串，分类筛选工具名候选 |
| 上下文检查 | `D:\a_dev_work\scripts\inspect-context.mjs` | 在二进制里搜指定字符串的所有出现位置，每处 dump ±180 字节上下文 |
| 偏移 dump | `D:\a_dev_work\scripts\dump-offset.mjs` | 给定偏移 dump 大块上下文（默认 ±2000 字节），用来定位完整 JS 代码块 |
| 提取结果 | `D:\a_dev_work\scripts\claude-tools-extracted.txt` | extract 脚本的输出（5 段分类：常量名 / 已知名命中 / 未命中 / 类名 / PascalCase 候选） |

### 1.4 逆向步骤（按顺序）

#### Step 1 — 定位 release 二进制

```bash
which claude                                    # /d/Program_dev/nodejs/claude (软链)
readlink -f /d/Program_dev/nodejs/claude        # 解到实际路径
cat /d/Program_dev/nodejs/node_modules/@anthropic-ai/claude-code/package.json | head
ls /d/Program_dev/nodejs/node_modules/@anthropic-ai/claude-code/bin/
file /d/Program_dev/nodejs/node_modules/@anthropic-ai/claude-code/bin/claude.exe
# -> PE32+ executable for MS Windows 6.00 (console), x86-64, 12 sections
```

#### Step 2 — 检查有没有明文的 SDK 类型声明（先吃低垂的果子）

```bash
sed -n '11,60p' /d/Program_dev/nodejs/node_modules/@anthropic-ai/claude-code/sdk-tools.d.ts
# -> 拿到 ToolInputSchemas union 的 23 个工具 Input 类型
```

这一步先把 SDK 公开的 ground truth 拿到，作为后面字符串扫描的对照基准。

#### Step 3 — 字节级提取二进制里所有 ASCII 字符串

跑 `extract-claude-tools.mjs`，核心逻辑（节选）：

```js
const buf = readFileSync(exePath)
let cur = ''
const strings = []
for (let i = 0; i < buf.length; i++) {
  const b = buf[i]
  if (b >= 0x20 && b <= 0x7e) {        // 可打印 ASCII
    cur += String.fromCharCode(b)
  } else {                              // 遇到非 ASCII 字节就截断
    if (cur.length >= 4) strings.push(cur)
    cur = ''
  }
}
const setAll = new Set(strings)        // 去重 -> 30 万 +
```

然后用 5 个正则/集合分类筛：

1. **`*_TOOL_NAME` 常量名** `/^[A-Z][A-Z0-9_]{2,}_TOOL_NAME$/` -> 7 个命中
2. **已知短工具名命中** —— 用 a_res 源码副本里的 44 个候选名做 `setAll.has(name)` 测试
3. **已知名未命中** -> 反推哪些 feature 没编入 release
4. **`XxxTool` 类名** `/^[A-Z][a-zA-Z0-9]{2,28}Tool$/` -> 25 个命中
5. **PascalCase 候选** —— 兜底捕获可能漏掉的新工具

结果写到 `claude-tools-extracted.txt`，分 A/B/C/D/E 五段。

```bash
cd /d/a_dev_work/scripts
node extract-claude-tools.mjs
# 输出:
# [INFO] 文件大小: 219.26 MB
# [INFO] 提取字符串总数: 1203150
# [INFO] 去重后: 316318
# [1] *_TOOL_NAME 常量名 (7): BRIEF_TOOL_NAME, CRON_*_TOOL_NAME, ...
# [2] 已知工具名 - 命中 (44): Agent, Bash, Read, ...
# [3] 已知工具名 - 未命中 (15): LSP, Snip, WebBrowser, ...
# [4] XxxTool 类名 (25): AgentOutputTool, BashOutputTool, ShareOnboardingGuideTool, ...
```

#### Step 4 — 鉴别"真注册工具" vs "仅字符串残留"

这一步至关重要。字符串扫到 `MultiEdit` 不代表它是真工具 —— 可能只是 prompt 文本或显示映射表里的兼容串。

用 `inspect-context.mjs` 把目标字符串在二进制里所有出现位置 + 上下文 dump 出来，每处 ±180 字节：

```bash
node inspect-context.mjs MultiEdit
# 5 处命中：全部是 prompt/TOOL_VERBS 映射，无 name: "MultiEdit" 工具注册 -> 伪工具
node inspect-context.mjs ShareOnboardingGuide
# 5 处命中：包含 var h28="ShareOnboardingGuide" + ShareOnboardingGuideTool() => ... -> 真工具
```

判定标准：
- [真工具] 上下文里出现 `name: "X"`、`var Xxx = "X"`、`XxxTool: () => ...`、`P8(..., {XxxTool: ...})` 这种**注册痕迹**
- [伪/残留] 只出现在 `TOOL_VERBS` 表（`{Read: "Reading", X: "Editing"}`）、prompt 字符串模板、deny rule 提示文本里

#### Step 5 — 定位关键 JS 代码块（找重命名映射、注册中心）

`inspect-context.mjs` 给的 ±180 字节有时不够看出整段逻辑。这时切到 `dump-offset.mjs`，给一个偏移 dump ±2000 字节，能看到完整的 IIFE 块：

```bash
# 之前找到 AU6 这个变量在偏移 214295830 附近
node dump-offset.mjs 214295830 2000
# 输出包含完整 IIFE:
# var _G = V(() => { AU6 = {Task: "Agent", KillShell: "TaskStop", ...} });
```

这就是 v2.1.145 的"老名 -> 新主名"重命名表（§3 详述）。

类似地：
```bash
node dump-offset.mjs 222035966 1500   # TaskOutput 工具定义 (JK({name:Bn, aliases:[...]}))
node dump-offset.mjs 222158523 2000   # ShareOnboardingGuide 工具定义
node dump-offset.mjs 108551128 1200   # 工具注册中心 (ToolSearchTool, CronCreateTool, ...)
```

#### Step 6 — 交叉验证

最后把三个数据源对账：

| 数据源 | 优点 | 局限 |
|---|---|---|
| `sdk-tools.d.ts` | 明文 ground truth，类型权威 | 只含 SDK 公开的子集 |
| `claude.exe` 字符串扫描 | 完整覆盖所有真实编入 release 的工具 | 字符串可能在 prompt 里误命中，需要 inspect-context 鉴别 |
| `a_res` 源码副本 | 含完整变量名、注释、逻辑 | 版本与 release 未必对齐，可能有 release 里没的 feature |

任何一个工具的存在性结论，都要至少两个数据源相互印证（或一个数据源 + 二进制 inspect-context 上下文确认）。

### 1.5 为什么不用专业反编译工具（IDA / Ghidra / radare2）

Bun 编译产物的特殊性：

- JS bundle 是**明文文本数据段**，不是机器码
- 用 IDA/Ghidra 反汇编出来的是 Bun runtime 本身的 C/Zig 代码（几十 MB），跟工具清单无关
- 真正想要的 JS 逻辑直接 ASCII 提取就能拿到，反汇编反而绕远路

**唯一例外**：如果想看 Bun runtime 怎么 unpack 这个 bundle、有没有运行时校验，那才需要反编译工具。本次目标只是"找工具名"，ASCII grep 足够了。

---

## 2. v2.1.145 真实工具清单（实测）

### 2.1 SDK 公开的工具输入/输出 union（最权威）

来源: `sdk-tools.d.ts:11-60`

```ts
export type ToolInputSchemas =
  | AgentInput | BashInput | TaskOutputInput | ExitPlanModeInput
  | FileEditInput | FileReadInput | FileWriteInput | GlobInput
  | GrepInput | TaskStopInput | ListMcpResourcesInput | McpInput
  | NotebookEditInput | ReadMcpResourceInput | TodoWriteInput
  | WebFetchInput | WebSearchInput | AskUserQuestionInput
  | TaskCreateInput | TaskGetInput | TaskUpdateInput | TaskListInput
  | EnterWorktreeInput | ExitWorktreeInput
  | ToolOutputSchemas;
```

注意：上面是**输入类型名**（`FileEditInput`），不是 agent `tools` 字段填的工具名。工具实际 `name` 字段对应关系：

| SDK 类型 | agent 配置里填的 name |
|---|---|
| `AgentInput` | `Agent` |
| `BashInput` | `Bash` |
| `TaskOutputInput` | `TaskOutput` |
| `ExitPlanModeInput` | `ExitPlanMode` |
| `FileEditInput` | `Edit` |
| `FileReadInput` | `Read` |
| `FileWriteInput` | `Write` |
| `GlobInput` | `Glob` |
| `GrepInput` | `Grep` |
| `TaskStopInput` | `TaskStop` |
| `ListMcpResourcesInput` | `ListMcpResources` |
| `McpInput` | （MCP 工具占位，非具体名） |
| `NotebookEditInput` | `NotebookEdit` |
| `ReadMcpResourceInput` | `ReadMcpResource` |
| `TodoWriteInput` | `TodoWrite` |
| `WebFetchInput` | `WebFetch` |
| `WebSearchInput` | `WebSearch` |
| `AskUserQuestionInput` | `AskUserQuestion` |
| `TaskCreateInput` | `TaskCreate` |
| `TaskGetInput` | `TaskGet` |
| `TaskUpdateInput` | `TaskUpdate` |
| `TaskListInput` | `TaskList` |
| `EnterWorktreeInput` | `EnterWorktree` |
| `ExitWorktreeInput` | `ExitWorktree` |

**这 23 个就是 v2.1.145 对外公开的核心工具集（SDK 维度）**。

### 2.2 二进制里额外命中、不在 SDK union 里的工具

二进制 grep 命中 + 已确认是真实注册的额外工具:

| 工具 name | 类名 | 说明 |
|---|---|---|
| `Skill` | `SkillTool` | 调用 skill |
| `EnterPlanMode` | `EnterPlanModeTool` | 进入计划模式 |
| `SendMessage` | `SendMessageTool` | agent 间通信 |
| `SendUserMessage` | `BriefTool` | 给用户发消息（aliases: `Brief`） |
| `ShareOnboardingGuide` | `ShareOnboardingGuideTool` | **新增：上传 ONBOARDING.md 到团队共享** |
| `TaskCreate`/`TaskGet`/`TaskUpdate`/`TaskList` | —— | Todo V2 任务管理 |
| `CronCreate`/`CronDelete`/`CronList` | —— | 定时触发（feature 启用） |
| `RemoteTrigger` | `RemoteTriggerTool` | 远程触发 |
| `Monitor` | `MonitorTool` | 监控 |
| `PushNotification` | `PushNotificationTool` | 推送通知 |
| `SendUserFile` | `SendUserFileTool` | 发文件给用户 |
| `Sleep` | —— | 休眠等待 |
| `ToolSearch` | `ToolSearchTool` | 延迟工具搜索 |
| `TeamCreate`/`TeamDelete` | `TeamCreateTool`/`TeamDeleteTool` | 团队管理 |
| `PowerShell` | `PowerShellTool` | Windows shell |
| `Config` | —— | Ant 内部配置 |
| `REPL` | —— | Ant 内部 REPL |
| `TestingPermission` | —— | 测试用 |
| `ListAgents` | —— | **新名（aliases: `ListPeers`）** |

注意 `Agent` 还有别名 `Task`（旧名），`TaskStop` 有别名 `KillShell`，`TaskOutput` 有别名 `AgentOutputTool` 和 `BashOutputTool`。详见 §3。

### 2.3 二进制里**没有**的（已被 tree-shake / 内部未发布）

下列在 `a_res/claude-code-main/` 源码副本里存在、但 v2.1.145 release 二进制扫不到 —— 说明被 feature flag 关掉、未编入发布版：

```
LSP, Snip, SubscribePR, SuggestBackgroundPR, SyntheticOutput,
WebBrowser, Workflow, Tungsten, OverflowTest, CtxInspect,
TerminalCapture, VerifyPlanExecution, ExitPlanModeV2
```

> 注：`ExitPlanModeV2` 在源码里常量名带 V2，但实际 `name` 字段就是 `ExitPlanMode`，所以二进制里只有 `ExitPlanMode` 这个字符串。功能上 V2 已替代 V1。
> `ListMcpResources` / `ReadMcpResource` 作为短名也没在我们 grep 的位置出现，但 `sdk-tools.d.ts` 里有，说明工具存在，只是字符串在被混淆的位置。

### 2.4 `MultiEdit` 在 v2.1.145 下的状态

[FAIL] **`MultiEdit` 已被官方移除，不再是注册工具**。

#### 三重证据互相印证

| 证据来源 | 结论 |
|---|---|
| 本机 `claude.exe` (v2.1.145) 字节扫描 | 5 次命中全部是 prompt 残留 + `TOOL_VERBS` 显示映射，**无任何工具注册痕迹** |
| 官方 [Tools reference](https://docs.claude.com/en/docs/claude-code/) | 当前 30+ 工具列表里**没有 MultiEdit**，文件操作只有 `Edit` / `Read` / `Write` |
| GitHub Issue [anthropics/claude-code#11125](https://github.com/anthropics/claude-code/issues/11125) | 用户报 "MultiEdit functionality is missing now"，Anthropic 标记 **"Closed as not planned"** —— 官方确认永久移除 |

#### 移除时间线

- **移除版本**: 约 v2.0.8 前后（2025-10/11）—— 由 issue #11125 时间线推断
- **changelog**: 没有专门条目，是**无声移除（silent removal）**
- **docs**: 没留 deprecated 提示
- 这就是为什么很多老 prompt / cheatsheet / 教程里还能看到 MultiEdit

#### 二进制 5 次命中逐一定位

| 偏移 | 类型 | 说明 |
|---|---|---|
| 121900832 | prompt 文本 | "Edit/Write/MultiEdit deny rule" 安全检查 prompt |
| 209805832 | `TOOL_VERBS` 表 | 状态显示映射：`MultiEdit → "Editing"` |
| 219671798 | prompt 文本 | 同 121900832 内容（重复编入） |
| 225053482 | `TOOL_VERBS` 表 | 同 209805832，源码 `src/bridge/sessionRunner.ts:74` 等价 |
| 227323992 | claude-api skill prompt | "Write, Edit, or MultiEdit call" prompt 文本 |

**全 5 处都是字符串残留，没有 `name: 'MultiEdit'`、`MultiEditTool`、`MULTI_EDIT_TOOL_NAME` 任何注册痕迹**。

实际验证片段（偏移 225053482）:

```js
auf = {
  Read: "Reading", Write: "Writing", Edit: "Editing",
  MultiEdit: "Editing",   // 仅用于显示，工具本身不存在
  Bash: "Running", Glob: "Searching", Grep: "Searching",
  ...
}
```

#### 替代方案（官方推荐）

1. **单文件多处替换** -> `Edit` + `replace_all: true` (`sdk-tools.d.ts:401` 已暴露该参数)
2. **多个不同 old_string/new_string 的替换** -> 多次顺序调用 `Edit`，Claude Code 会在同一轮内批量执行
3. **整文件重写** -> 直接 `Write`

#### 结论

- 写 `tools: [..., MultiEdit, ...]` 在 v2.1.145 下会被 `resolveAgentTools()` 静默忽略
- 这不是 v2.1.145 的版本问题，而是官方**已永久移除**该工具，且明确"not planned" 复活

---

## 3. 关键 alias / 重命名映射表（直接来自二进制）

最重要的发现 —— 偏移 214295830 处的原始 JS 代码：

```js
var AU6, O78 = "workspace", Eb8, _P$;
var _G = V(() => {
  AU6 = {
    Task: "Agent",                       // Task -> Agent
    KillShell: "TaskStop",               // KillShell -> TaskStop
    AgentOutputTool: "TaskOutput",       // AgentOutputTool -> TaskOutput
    BashOutputTool: "TaskOutput",        // BashOutputTool -> TaskOutput
    ListPeers: "ListAgents",             // ListPeers -> ListAgents
    Brief: "SendUserMessage"             // Brief -> SendUserMessage
  };
  Eb8 = `mcp__${O78}__bash`,
  _P$ = `mcp__${O78}__web_fetch`
});
```

这是**老名 → 新主名**的归一化表。结合 `TaskOutput` 工具定义（偏移 222035966）:

```js
DO6 = JK({
  name: Bn,                                        // Bn = "TaskOutput"
  searchHint: "read output/logs from a background task",
  maxResultSizeChars: 1e5,
  shouldDefer: !0,
  aliases: ["AgentOutputTool", "BashOutputTool"],  // 走 aliases 字段
  userFacingName() { return "Task Output" },
  ...
  description: "[Deprecated] — for bash and remote_agent tasks, prefer Read..."
})
```

可以确认：

| 主名 (写在 tools 字段里有效) | aliases (历史名，**写了不生效**) | 备注 |
|---|---|---|
| `Agent` | `Task` | a_res 源码 `LEGACY_AGENT_TOOL_NAME = 'Task'` |
| `TaskStop` | `KillShell` | KillShell 是旧 API 残留 |
| `TaskOutput` | `AgentOutputTool`, `BashOutputTool` | 两个工具被合并；自身被标 [Deprecated] |
| `ListAgents` | `ListPeers` | **release 版改名了**，源码副本里还叫 ListPeers |
| `SendUserMessage` | `Brief` | a_res 源码 `LEGACY_BRIEF_TOOL_NAME = 'Brief'` |

> 上一篇文档里"alias 不查"的结论：仍然成立。这张表只是**重命名映射**（用于兼容老 transcript 和老插件输出），agent 配置层 `resolveAgentTools()` 只查 `tool.name` 精确主名。

---

## 4. 新增工具：`ShareOnboardingGuide`

二进制里这是个**完整注册的新工具**（a_res 源码副本里没有），偏移 222158523 / 222165496：

```js
var h28 = "ShareOnboardingGuide",
Eyq = `Upload the ONBOARDING.md in the current directory and return a share link
teammates can open in Claude Code. Call this after the user has confirmed the
final content.

When called with the default mode='check': if a local ONBOARDING.md is present,
uploads it to the most-recently-updated org guide (or creates one if none
exist) and returns a fresh link. If no local file is present, returns the
existing link without uploading (status: has_existing).`;

var Ya7 = {};
P8(Ya7, {ShareOnboardingGuideTool: () => E$f});
```

并且出现在 `getAllBaseTools()` 等价函数的注册链里（偏移 108551128）:

```
... ToolSearchTool ... CronCreateTool ... CronDeleteTool ... CronListTool ...
RemoteTriggerTool ... SendUserFileTool ... PushNotificationTool ...
TeamCreateTool ... TeamDeleteTool ... SendMessageTool ...
ShareOnboardingGuideTool ... PowerShellTool ...
```

**主名**: `ShareOnboardingGuide`
**类名**: `ShareOnboardingGuideTool`
**用途**: 把项目根目录的 `ONBOARDING.md` 上传到 Anthropic 团队组织空间，返回一个可分享链接。第一次调用会自动创建团队 guide，后续调用更新最近的那一份。

> 这个工具我（Claude Code）当前对话也能看到 —— 它就是我工具列表里的 `ShareOnboardingGuide`。

---

## 5. v2.1.145 实测可用工具完整清单（自定义 agent 配置时可填）

按"上一篇规则文档"的口径，下面是 **v2.1.145 release 版本里 agent `tools:` 字段填了能生效**的工具主名全集：

### 5.1 内置工具（默认池）

```
Agent              Bash               Read               Edit
Write              NotebookEdit       Glob               Grep
WebFetch           WebSearch          TodoWrite          AskUserQuestion
Skill              EnterPlanMode      ExitPlanMode       SendUserMessage
SendMessage        TaskOutput         TaskStop           ListMcpResources
ReadMcpResource    ToolSearch         ShareOnboardingGuide
```

### 5.2 Feature / 模式启用

```
# Todo V2
TaskCreate         TaskGet            TaskUpdate         TaskList

# 团队 / 多 agent
ListAgents         TeamCreate         TeamDelete

# Worktree
EnterWorktree      ExitWorktree

# 触发器 / 通知
CronCreate         CronDelete         CronList
RemoteTrigger      Monitor            Sleep
PushNotification   SendUserFile

# 平台
PowerShell         # Windows
```

### 5.3 Ant 内部 / 测试

```
Config             REPL               TestingPermission
```

### 5.4 不建议在 agent 配置里写的（无效或不存在）

```
MultiEdit          # 不存在，用 Edit + replace_all
Task               # alias，会被忽略，要写 Agent
Brief              # alias，要写 SendUserMessage
KillShell          # alias，要写 TaskStop
AgentOutputTool    # alias，要写 TaskOutput
BashOutputTool     # alias，要写 TaskOutput
ListPeers          # 已重命名为 ListAgents
```

---

## 6. 用户那行配置在 v2.1.145 下的复核

```yaml
tools: [Read, Grep, Glob, Bash, Write, Edit, MultiEdit, Skill, TodoWrite]
```

| 名字 | v2.1.145 结果 | 说明 |
|---|---|---|
| Read | [PASS] | sdk-tools.d.ts FileReadInput + 二进制确认 |
| Grep | [PASS] | sdk-tools.d.ts GrepInput + 二进制确认 |
| Glob | [PASS] | sdk-tools.d.ts GlobInput + 二进制确认 |
| Bash | [PASS] | sdk-tools.d.ts BashInput + 二进制确认 |
| Write | [PASS] | sdk-tools.d.ts FileWriteInput + 二进制确认 |
| Edit | [PASS] | sdk-tools.d.ts FileEditInput + 二进制确认 |
| **MultiEdit** | **[FAIL]** | **二进制 5 次命中全部是 prompt/显示映射，无工具注册** |
| Skill | [PASS] | 二进制有 SkillTool 类名 + Skill 短名 |
| TodoWrite | [PASS] | sdk-tools.d.ts TodoWriteInput + 二进制确认 |

**修正后**:

```yaml
tools: [Read, Grep, Glob, Bash, Write, Edit, Skill, TodoWrite]
```

---

## 7. 自己跑一遍的命令

```bash
# 1. 看 SDK 暴露的工具 union (类型定义)
sed -n '11,60p' /d/Program_dev/nodejs/node_modules/@anthropic-ai/claude-code/sdk-tools.d.ts

# 2. 扫整个二进制，输出工具相关字符串候选清单
cd /d/a_dev_work/scripts
node extract-claude-tools.mjs

# 输出会写到 claude-tools-extracted.txt，包含 5 段:
#   A. *_TOOL_NAME 常量
#   B. 已知短工具名 - 命中
#   C. 已知短工具名 - 未命中
#   D. XxxTool 类名
#   E. PascalCase 候选名

# 3. 验证任意候选名在二进制里的上下文 (确认是注册工具还是仅字符串)
node inspect-context.mjs MultiEdit                  # 验证伪工具
node inspect-context.mjs ShareOnboardingGuide       # 看新工具定义
node inspect-context.mjs Skill ToolSearch SendMessage  # 多个一起

# 4. dump 指定偏移的大块上下文 (定位到 JS 源码块)
node dump-offset.mjs 214295830 2000  # AU6 重命名映射表
node dump-offset.mjs 222035966 1500  # TaskOutput 工具定义
node dump-offset.mjs 222158523 2000  # ShareOnboardingGuide 工具定义
```

---

## 8. 与上一篇 a_res 源码版本的差异总结

| 维度 | a_res/claude-code-main (内部源码副本) | v2.1.145 (npm release) |
|---|---|---|
| 数据形式 | TypeScript 源码 | Bun 编译的 PE32+ 二进制 |
| 工具数（上限） | ~50+（含所有 feature flag 分支） | ~30 启用 |
| LSP / Snip / WebBrowser / Workflow / Tungsten 等 | 存在源码 | tree-shake 掉，二进制扫不到 |
| ListPeers / ListAgents | 仅 `ListPeers` | 主名改为 `ListAgents`，`ListPeers` 是 alias |
| AgentOutputTool / BashOutputTool / TaskOutput | 仅 `TaskOutput` 一个 | `TaskOutput` 主名，两个老名作 aliases，标 [Deprecated] |
| ShareOnboardingGuide | 不存在 | **新增工具** |
| MultiEdit | 仅 TOOL_VERBS 显示映射 | 同样仅 TOOL_VERBS 显示映射（无变化） |
| KillShell | 未见 | `TaskStop` 的 alias |
| TaskOutput 状态 | 正常工具 | **被标 [Deprecated]**（建议直接 Read 输出文件） |

**结论**：v2.1.145 实测清单是当前你日常用 ccode 时真正能配的工具。上一篇的"规则与解析链路"（基于 a_res 源码）仍然准确 —— 解析机制没变，变的只是工具集本身。

---

## 9. 单一真源速记

| 关注点 | 来源 |
|---|---|
| SDK 公开工具 union | `node_modules/@anthropic-ai/claude-code/sdk-tools.d.ts:11-60` |
| 二进制本体 | `node_modules/@anthropic-ai/claude-code/bin/claude.exe` |
| 老名 -> 新主名映射 | 二进制偏移 214295830 (AU6 对象) |
| TaskOutput 工具注册 + aliases | 二进制偏移 222035966 |
| ShareOnboardingGuide 注册 | 二进制偏移 222158523 / 222165496 |
| 工具注册中心（assemble 池） | 二进制偏移 108551128 附近 |
| 提取脚本 | `D:\a_dev_work\scripts\extract-claude-tools.mjs` |
| 上下文检查脚本 | `D:\a_dev_work\scripts\inspect-context.mjs` |
| 偏移 dump 脚本 | `D:\a_dev_work\scripts\dump-offset.mjs` |
| 提取结果 dump | `D:\a_dev_work\scripts\claude-tools-extracted.txt` |
