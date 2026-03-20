# CCode Runtime Plugin 插件体系设计

> 日期: 2026-03-20
> 状态: 设计中
> 定位: 平台级能力 — CCode 的第四层扩展体系

---

## 一、背景与动机

### 1.1 现有三层扩展的局限

CCode 当前有三层扩展机制，各自覆盖不同维度：

```
① Skills（文本层）    — SKILL.md 注入 system prompt，改变 LLM 行为
② Hooks（事件层）     — hooks.json 在事件前后执行 shell 命令
③ MCP（工具层）       — .mcp.json 注册外部工具给 LLM 调用
```

但当需要**改变 CCode 本身的运行时行为**时，三层都无能为力：

| 需求 | Skills | Hooks | MCP |
|------|--------|-------|-----|
| 注册新的斜杠命令 | ❌ | ❌ | ❌ |
| 在 InputBar 旁加按钮 | ❌ | ❌ | ❌ |
| 监听全局快捷键 | ❌ | ❌ | ❌ |
| 注入文本到输入框 | ❌ | ❌ | ❌ |
| 修改状态栏显示 | ❌ | ❌ | ❌ |
| 拦截/修改用户输入 | ❌ | ⚠️ 有限 | ❌ |
| 添加新的 Tool 并让用户直接触发 | ❌ | ❌ | ⚠️ LLM 触发 |

### 1.2 需要第四层：Runtime Plugin

```
④ Runtime Plugin（运行时层）— 新增
   本质：一段 JS/TS 代码加载到 CCode 进程内运行
   能力：注册命令、注册工具、修改 UI、监听事件、访问状态
   形态：npm 包 + 约定接口
```

**第一个消费者**：`ccode-plugin-voice`（语音输入插件）——需要注册 `/voice` 命令、加麦克风按钮、监听快捷键、录音→识别→注入输入框。

### 1.3 与 Claude Code 插件生态的关系

```
Claude Code 插件 = Skills + Hooks + marketplace 元数据
CCode Runtime Plugin = Skills + Hooks + 可执行代码（超集）

兼容策略：
  Claude Code 插件 → CCode 正常加载 Skills 和 Hooks，跳过不存在的 runtime/
  CCode Runtime Plugin → Claude Code 只加载 Skills 和 Hooks，忽略 runtime/
```

**完全向后兼容**，Claude Code 生态的插件（如 superpowers）无需任何改动即可在 CCode 中使用。CCode 的 Runtime Plugin 是在此基础上的增强。

---

## 二、核心接口定义

### 2.1 CCodePlugin 接口

```typescript
/**
 * CCode Runtime Plugin 接口。
 *
 * 插件是一个 npm 包，默认导出一个实现此接口的对象。
 * CCode 启动时发现并加载插件，调用 activate() 注册能力。
 */
interface CCodePlugin {
  /** 插件名称（唯一标识） */
  name: string
  /** 版本号 */
  version: string
  /** 描述 */
  description: string

  /**
   * 激活 — CCode 启动时调用。
   * 插件在此方法内通过 context 注册命令、工具、UI 扩展等。
   * 可以是异步的（如需要初始化外部资源）。
   */
  activate(context: PluginContext): void | Promise<void>

  /**
   * 停用 — CCode 退出时调用。
   * 清理资源（关闭连接、停止录音、移除监听器等）。
   */
  deactivate?(): void | Promise<void>
}
```

### 2.2 PluginContext 扩展点

```typescript
/**
 * 插件上下文 — 提供所有扩展点。
 *
 * 设计原则：
 * - 最小权限：插件只能通过 context 暴露的 API 与 CCode 交互
 * - 命名空间隔离：命令和工具自动加插件名前缀（可选）
 * - 生命周期管理：activate 注册的资源在 deactivate 时自动清理
 */
interface PluginContext {
  // ═══ 命令扩展 ═══

  /**
   * 注册斜杠命令。
   * 用户在输入框输入 /voice 时触发。
   * 命令名自动出现在 /help 列表和命令建议浮层中。
   */
  registerCommand(command: PluginCommand): void

  // ═══ 工具扩展 ═══

  /**
   * 注册 Tool（LLM 可调用的工具）。
   * 注册后 LLM 的 tools 参数中会包含此工具的 JSON Schema。
   */
  registerTool(tool: Tool): void

  // ═══ 事件扩展 ═══

  /**
   * 监听事件（AgentEvent / BridgeEvent）。
   * 可用于观察 LLM 调用、工具执行、用户输入等。
   */
  onEvent(type: string, handler: (event: unknown) => void): Disposable

  /**
   * 发布事件到 EventBus。
   * 其他插件和 CCode 核心都能收到。
   */
  emit(event: Record<string, unknown>): void

  // ═══ UI 扩展点 ═══

  /**
   * 在 InputBar 旁注册操作按钮。
   * 如：麦克风图标、翻译按钮、模板选择器等。
   */
  registerInputAction(action: InputAction): void

  /**
   * 在状态栏注册信息项。
   * 如：录音状态、连接状态、自定义计数器等。
   */
  registerStatusBarItem(item: StatusBarItem): void

  /**
   * 注入文本到输入框（不发送，让用户确认后再发）。
   */
  injectInput(text: string): void

  /**
   * 直接提交文本（等同用户按 Enter）。
   */
  submitInput(text: string): void

  /**
   * 追加系统消息（仅 UI 显示，不发给 LLM）。
   */
  appendSystemMessage(text: string): void

  // ═══ 状态访问 ═══

  /** 当前会话 ID */
  getSessionId(): string | null
  /** 当前工作目录 */
  getCwd(): string
  /** 当前模型名 */
  getModel(): string
  /** 当前 Provider 名 */
  getProvider(): string
  /** 当前对话消息列表（只读） */
  getMessages(): ReadonlyArray<{ role: string; content: string }>

  // ═══ 持久化存储 ═══

  /**
   * 插件专属 key-value 存储。
   * 数据持久化到 ~/.ccode/plugins/<name>/storage.json
   */
  storage: PluginStorage
}

/** 可释放资源（事件监听器等） */
interface Disposable {
  dispose(): void
}

/** 插件注册的斜杠命令 */
interface PluginCommand {
  name: string
  description: string
  /** 别名（如 /v → /voice） */
  aliases?: string[]
  /** 执行逻辑 */
  execute(args: string[]): void | Promise<void>
}

/** InputBar 旁的操作按钮 */
interface InputAction {
  id: string
  /** 显示文本或图标字符 */
  label: string
  /** 全局快捷键（如 'ctrl+shift+v'） */
  shortcut?: string
  /** 提示文本 */
  tooltip?: string
  /** 点击/快捷键触发 */
  handler(): void | Promise<void>
}

/** 状态栏信息项 */
interface StatusBarItem {
  id: string
  /** 显示内容（支持动态更新） */
  getText(): string
  /** 文本颜色 */
  getColor?(): string | undefined
  /** 点击回调 */
  onClick?(): void
}

/** 插件持久化存储 */
interface PluginStorage {
  get<T>(key: string, defaultValue?: T): T | undefined
  set<T>(key: string, value: T): void
  delete(key: string): void
  keys(): string[]
}
```

---

## 三、插件目录结构

### 3.1 作为 npm 包

```
ccode-plugin-voice/                 ← npm 包名
├── package.json                    ← 含 "ccode-plugin" 标记
│   {
│     "name": "ccode-plugin-voice",
│     "version": "0.1.0",
│     "main": "dist/index.js",
│     "ccode-plugin": {             ← 插件元数据
│       "displayName": "Voice Input",
│       "description": "语音输入 — 说话转文字",
│       "activationEvents": ["*"]   ← 始终激活（或按需激活）
│     }
│   }
├── dist/
│   └── index.js                    ← 编译后的插件入口
├── src/
│   └── index.ts                    ← CCodePlugin 实现
├── skills/                         ← 可选：附带的 Skills
│   └── voice-prompt/
│       └── SKILL.md
├── hooks/                          ← 可选：附带的 Hooks
│   └── hooks.json
└── README.md
```

### 3.2 作为本地插件（兼容 Claude Code 目录结构）

```
~/.ccode/plugins/
└── my-plugin/                      ← 插件目录名
    ├── plugin.json                 ← 兼容 Claude Code 格式
    ├── skills/                     ← Skills（兼容）
    ├── hooks/                      ← Hooks（兼容）
    └── runtime/                    ← 新增：Runtime Plugin
        └── index.js                ← CCodePlugin 入口
```

**兼容逻辑**：
- 有 `runtime/index.js` → 加载为 Runtime Plugin（新能力）
- 只有 `skills/` 和 `hooks/` → 当传统插件加载（现有逻辑不变）
- Claude Code 格式的插件 → 正常工作，runtime/ 不存在则跳过

---

## 四、插件发现与加载

### 4.1 发现来源（优先级从低到高）

```
1. npm 全局安装的插件
   → 约定包名前缀：ccode-plugin-*
   → 扫描路径：npm root -g + /ccode-plugin-*/

2. 配置文件声明
   → ~/.ccode/config.json: { "plugins": ["ccode-plugin-voice", "./local-plugin"] }

3. 用户级插件目录
   → ~/.ccode/plugins/<name>/runtime/index.js

4. 项目级插件目录
   → <project>/.ccode/plugins/<name>/runtime/index.js
```

### 4.2 加载流程

```
bootstrapAll() 阶段：

  ├─ 链 A（现有）：Skills → Instructions → Hooks → SystemPrompt
  ├─ 链 B（现有）：文件索引扫描
  └─ 链 C（新增）：Runtime Plugin 发现 → 加载 → 激活

  Plugin 加载流程：
    1. 扫描所有来源，收集插件路径
    2. 对每个插件：
       a. 动态 import(pluginPath) → 获取 CCodePlugin 对象
       b. 构建 PluginContext（注入扩展点 + 命名空间隔离）
       c. 调用 plugin.activate(context)
       d. 注册到 PluginRegistry（供 /plugins 命令查看）
    3. 所有插件激活完成后，合并到主系统：
       - 注册的命令 → CommandRegistry
       - 注册的工具 → ToolRegistry
       - 注册的 UI 扩展 → App.tsx 渲染
```

### 4.3 生命周期

```
CCode 启动
  ↓
bootstrapAll()
  ↓
发现插件 → 加载 → activate()
  ↓
CCode 运行中（插件注册的命令/工具/UI 生效）
  ↓
CCode 退出
  ↓
逐个调用 plugin.deactivate()
  ↓
进程退出
```

---

## 五、安全与隔离

### 5.1 信任模型

采用 **VS Code 式信任模型**：用户安装 = 信任。不做沙箱。

理由：
- Runtime Plugin 本质是 Node.js 代码，完全沙箱化成本极高
- 用户通过 `npm i` 或手动放目录安装，是主动行为
- Claude Code 的插件也没有沙箱

### 5.2 容错隔离

```typescript
// 插件 activate 崩溃不影响 CCode 启动
try {
  await plugin.activate(context)
} catch (err) {
  console.error(`Plugin "${plugin.name}" activation failed:`, err)
  // 跳过此插件，CCode 继续启动
}

// 插件注册的命令执行崩溃不影响主流程
try {
  await command.execute(args)
} catch (err) {
  appendSystemMessage(`Plugin command error: ${err.message}`)
}
```

### 5.3 命名空间

```
插件注册的命令：自动加前缀（可选）
  plugin.name = "voice"
  registerCommand({ name: "start" })
  → 注册为 /voice:start 或 /voice（如果只有一个命令）

插件注册的工具：自动加前缀
  registerTool({ name: "record" })
  → 注册为 voice__record（类似 MCP 工具的 mcp__server__tool 格式）

冲突处理：
  - 命令名冲突 → 后加载的覆盖先加载的（项目级 > 用户级 > npm）
  - 工具名冲突 → 同上
```

---

## 六、第一个插件：ccode-plugin-voice

### 6.1 架构

```
两个独立项目：

voice-paste（独立 npm 包，不依赖 CCode）
  → 纯 CLI 工具：录音 → STT → 剪贴板 → 粘贴
  → 可独立使用，也可被其他项目调用
  → npm i -g voice-paste && voice-paste

ccode-plugin-voice（CCode Runtime Plugin）
  → 桥接 voice-paste 到 CCode
  → 注册 /voice 命令
  → InputBar 加麦克风按钮
  → 快捷键 Ctrl+Shift+V
  → npm i -g ccode-plugin-voice
```

### 6.2 插件实现草案

```typescript
// ccode-plugin-voice/src/index.ts

import type { CCodePlugin, PluginContext } from 'ccode-cli/plugin'

const plugin: CCodePlugin = {
  name: 'voice',
  version: '0.1.0',
  description: '语音输入 — 说话转文字，自动填入输入框',

  activate(ctx) {
    // 1. 注册 /voice 命令
    ctx.registerCommand({
      name: 'voice',
      description: 'Start voice input (speak → text → input)',
      aliases: ['v'],
      async execute() {
        ctx.appendSystemMessage('🎤 Listening...')
        try {
          // 调用 voice-paste 核心库
          const { record, recognize } = await import('voice-paste')
          const audio = await record({ maxDuration: 30 })
          const text = await recognize(audio, { provider: 'whisper' })
          if (text) {
            ctx.injectInput(text)
            ctx.appendSystemMessage(`🎤 → "${text}"`)
          } else {
            ctx.appendSystemMessage('🎤 No speech detected')
          }
        } catch (err) {
          ctx.appendSystemMessage(`🎤 Error: ${err.message}`)
        }
      },
    })

    // 2. InputBar 旁加麦克风按钮
    ctx.registerInputAction({
      id: 'voice-mic',
      label: '🎤',
      shortcut: 'ctrl+shift+v',
      tooltip: 'Voice input (Ctrl+Shift+V)',
      async handler() {
        // 复用 /voice 命令逻辑
        await ctx.executeCommand('voice')
      },
    })

    // 3. 状态栏显示录音状态
    let isRecording = false
    ctx.registerStatusBarItem({
      id: 'voice-status',
      getText: () => isRecording ? '🔴 Recording...' : '',
      getColor: () => isRecording ? 'red' : undefined,
    })
  },
}

export default plugin
```

---

## 七、实施路线

```
Phase 1: 基础设施（P0）
  ├─ PluginContext 接口定义 + 类型导出（ccode-cli/plugin）
  ├─ PluginRegistry（发现、加载、激活、停用）
  ├─ bootstrapAll() 集成插件加载链
  ├─ 命令扩展：插件命令注入 CommandRegistry
  ├─ 工具扩展：插件工具注入 ToolRegistry
  └─ /plugins 命令（列出已加载插件）

Phase 2: UI 扩展点（P1）
  ├─ InputAction 渲染（InputBar 旁的操作按钮）
  ├─ StatusBarItem 渲染（状态栏信息项）
  ├─ injectInput / submitInput API
  └─ Web 端同步（插件 UI 通过 EventBus 广播到 Web）

Phase 3: 第一个插件 voice（P1）
  ├─ voice-paste 独立 npm 包（录音 + STT + 剪贴板）
  └─ ccode-plugin-voice（CCode 桥接插件）

Phase 4: 生态完善（P2）
  ├─ 插件模板脚手架（ccode create-plugin）
  ├─ 插件文档（开发指南 + API 参考）
  └─ 更多官方插件（translate、copilot-mode、vim-mode...）
```

---

## 八、扩展维度全景

Runtime Plugin 让 CCode 具备了四层完整的扩展体系：

```
┌──────────────────────────────────────────────────────┐
│                                                      │
│  ④ Runtime Plugin（运行时层）— 新增                  │
│     代码级扩展：命令、工具、UI、事件、状态            │
│     → 改变 CCode 的形态和能力                        │
│                                                      │
│  ③ MCP（工具层）                                     │
│     外部进程：注册工具给 LLM 调用                    │
│     → 扩展 LLM 的能力边界                            │
│                                                      │
│  ② Hooks（事件层）                                   │
│     Shell 命令：事件前后拦截                          │
│     → 注入外部逻辑到工作流                           │
│                                                      │
│  ① Skills（文本层）                                  │
│     Prompt 注入：改变 LLM 行为                       │
│     → 教 LLM 新的工作方式                            │
│                                                      │
└──────────────────────────────────────────────────────┘
```

**形态改变的可能性**：

| 插件 | 扩展维度 | 形态变化 |
|------|----------|----------|
| `ccode-plugin-voice` | 命令 + UI + 快捷键 | 加麦克风按钮，语音输入 |
| `ccode-plugin-translate` | 命令 + 事件监听 | 实时翻译 AI 回复 |
| `ccode-plugin-vim` | 命令 + UI 替换 | InputBar 变为 vim 模式编辑器 |
| `ccode-plugin-copilot` | 事件监听 + UI | 变成内联代码补全模式 |
| `ccode-plugin-team` | 命令 + 事件 + 工具 | 多人共享 session |
| `ccode-plugin-tui-dashboard` | UI 替换 | 全屏 TUI dashboard 模式 |
| `ccode-plugin-security` | Hooks + 事件 | 工具调用审计 + 敏感操作拦截 |

---

## 九、与竞品插件体系对比

| 维度 | Claude Code | VS Code Extensions | CCode Runtime Plugin |
|------|------------|-------------------|---------------------|
| 文本扩展 | Skills (SKILL.md) | — | ✅ 兼容 |
| 事件钩子 | Hooks (shell) | — | ✅ 兼容 |
| 工具扩展 | MCP | Language Server | ✅ MCP + registerTool |
| 代码级扩展 | ❌ 无 | ✅ Extension API | ✅ PluginContext API |
| UI 扩展 | ❌ 无 | ✅ Webview/TreeView | ✅ InputAction/StatusBar |
| 命令扩展 | ❌ 无 | ✅ registerCommand | ✅ registerCommand |
| 市场 | 有（有限） | 丰富 | 规划中 |
| 信任模型 | 安装即信任 | 安装即信任 | 安装即信任 |

CCode 的 Runtime Plugin 体系定位在 Claude Code（只有文本+事件）和 VS Code（完整 Extension API）之间——比 Claude Code 强大，比 VS Code 轻量。
