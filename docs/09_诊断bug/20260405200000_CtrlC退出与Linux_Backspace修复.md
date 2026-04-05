# Bug 修复报告：Ctrl+C 双击退出失效 & Linux Backspace 行为异常

> 诊断时间：2026-04-05 20:00
> 影响范围：CLI 交互核心体验
> 修复文件：`src/ui/App.tsx`、`src/ui/InputBar.tsx`、`src/commands/exit.ts`、`src/commands/types.ts`

---

## Bug 1：双击 Ctrl+C 无法退出

### 症状

在 streaming 或权限确认状态下，连续按两次 Ctrl+C 无法退出程序，必须强制关闭终端窗口。

### 根因分析

`App.tsx` 的 Ctrl+C 处理逻辑将**双击检测**和**状态判断**耦合在一起，导致三种场景下退出失效：

```
原有逻辑（伪代码）：
if (isStreaming && !pendingPermission) {
  if (isCtrlC) abort()             // ← 永远走这里，不累计双击计时
} else if (isCtrlC && !isStreaming) {
  if (双击) exit()                  // ← streaming 期间永远到不了这里
}
```

**场景 1：Streaming 期间**

| 按键次序 | isStreaming | 走哪个分支 | 结果 |
|---------|-----------|----------|------|
| 第 1 次 Ctrl+C | true | `abort()` | 中断流，但 `lastCtrlCRef` **未更新** |
| 第 2 次 Ctrl+C（<2s） | **仍为 true**（React 异步更新） | 又走 `abort()` | **无法退出** |

关键点：`setIsStreaming(false)` 在 AgentLoop 的 `finally` 块中，要等 async generator 完全 unwind 后才执行。在第 1 次 abort 到第 2 次按键之间的几百毫秒内，`isStreaming` 仍为 `true`。

**场景 2：权限确认弹窗**

`isStreaming === true && pendingPermission != null` 时，两个分支**都不匹配**：
- `isStreaming && pendingPermission == null` → false
- `isCtrlC && !isStreaming` → false

Ctrl+C 被完全忽略，无任何响应。

**场景 3：abort 后短暂的 isStreaming=true 窗口**

即使 abort 成功开始清理，React state 的异步批量更新导致 `isStreaming` 在下一个 render cycle 前不会变 false。这个"真空期"内的 Ctrl+C 仍走 abort 分支。

### 修复方案

**核心原则：双击检测优先于一切状态判断。**

```typescript
useInput((input, key) => {
  const isCtrlC = input === 'c' && key.ctrl

  if (isCtrlC) {
    const now = Date.now()
    // 双击检测最优先——无论 streaming/pending/空闲，双击必退出
    if (now - lastCtrlCRef.current < DOUBLE_CTRLC_MS) {
      process.exit(0)  // 强制退出，不依赖 Ink 异步卸载
      return
    }
    lastCtrlCRef.current = now

    if (isStreaming && pendingPermission == null) {
      abort()
      appendSystemMessage('⏹ 已中断响应（再次 Ctrl+C 退出）')
    } else {
      appendSystemMessage('再次 Ctrl+C 退出')
    }
    return
  }

  // Escape 仅在 streaming 期间中断，不参与退出逻辑
  if (key.escape && isStreaming && pendingPermission == null) {
    abort()
    appendSystemMessage('⏹ 已中断响应')
  }
})
```

修复后行为：

| 场景 | 第 1 次 Ctrl+C | 第 2 次 Ctrl+C | 能退出？ |
|------|-------------|-------------|---------|
| 空闲 | 提示"再次 Ctrl+C 退出" | `process.exit(0)` | ✅ |
| Streaming | abort + 提示 | `process.exit(0)` | ✅ |
| 权限确认 | 提示"再次 Ctrl+C 退出" | `process.exit(0)` | ✅ |

### 附带改进：/exit 指令强制退出

原有 `/exit` 和 `/quit` 是硬编码在 `handleSubmit` 中的特殊逻辑，调用 Ink 的 `exit()`（异步卸载，某些场景会挂起）。

修复：
1. 新建 `ExitCommand`（别名 `/quit`），注册到 `CommandRegistry`，在建议列表中可见
2. 新增 `CommandAction: force_exit`，由 `process.exit(0)` 强制退出
3. 移除旧的硬编码逻辑
4. 整体退出策略统一从 Ink `exit()` 改为 `process.exit(0)`，`ccli.ts` 的 `process.on('exit')` 回调仍会执行清理

---

## Bug 2：Linux 下 Backspace 键行为异常

### 症状

在 Linux 终端中按 Backspace 键：
- 不是向左退格，而是**向右删除**（Delete 行为）
- 或者完全无反应

### 根因分析

问题出在 Ink 5.x 的 `parse-keypress.js` 对按键字节码的映射。

**终端发送的字节码（平台差异）：**

| 按键 | Windows 终端 | Linux 终端 |
|------|------------|-----------|
| Backspace | `\b` (0x08) | `\x7f` (0x7F, ASCII DEL) |
| Delete | `\x1b[3~` | `\x1b[3~` |

**Ink parse-keypress 的映射逻辑：**

```javascript
// parse-keypress.js 第 158-168 行
if (s === '\b' || s === '\x1b\b') {
  key.name = 'backspace'          // ← 只有 \b(0x08) 被识别为 backspace
}
else if (s === '\x7f' || s === '\x1b\x7f') {
  // TODO: enquirer detects delete key as backspace, but I had to
  // split them up to avoid breaking changes in Ink.
  key.name = 'delete'             // ← \x7f(Linux Backspace) 被错误地映射为 delete!
}
```

Ink 源码注释自己承认了这是已知问题，但为了向后兼容没有修复。

**传导到 useInput：**

```javascript
// use-input.js
const key = {
  backspace: keypress.name === 'backspace',  // Linux 下永远 false
  delete: keypress.name === 'delete',        // Linux Backspace 和 Delete 都是 true
}
```

**到 InputBar 的 useInput 回调：**

```
原有代码：
if (key.backspace) { 向左删除 }   // ← Linux 永远不触发
if (key.delete)    { 向右删除 }   // ← Linux 的 Backspace 走到这里，行为反了
```

### 修复方案

采用**双层处理策略**：

**第一层：stdin raw listener（prependListener 抢先拦截）**

只处理真正的 Delete 键 `\x1b[3~`，执行向右删除，并设置 `handledByRawRef` flag：

```typescript
const isDelete = str === '\x1b[3~'
if (isDelete) {
  handledByRawRef.current = true  // 标记已处理，防止 useInput 重复处理
  if (cur < val.length) {
    const newValue = val.slice(0, cur) + val.slice(cur + 1)
    onChange(newValue)
  }
}
```

**第二层：useInput 回调**

`key.backspace || key.delete` 统一当退格处理，但先检查 flag 排除已处理的 Delete：

```typescript
if (key.backspace || key.delete) {
  if (handledByRawRef.current) {
    handledByRawRef.current = false  // 真 Delete 已被 raw listener 处理
    return
  }
  // 退格：向左删除
  if (cursorIndex > 0) {
    const newValue = value.slice(0, cursorIndex - 1) + value.slice(cursorIndex)
    onChange(newValue)
    setCursorIndex(cursorIndex - 1)
  }
}
```

**修复后行为：**

| 按键 | Windows | Linux |
|------|---------|-------|
| Backspace | `key.backspace=true` → 向左退格 ✅ | `key.delete=true` → flag 未设 → 向左退格 ✅ |
| Delete | `key.delete=true` → flag 未设 → 向左退格 ⚠️ | `\x1b[3~` → raw listener 向右删除 + 设 flag → useInput 跳过 ✅ |

> Windows Delete 键的行为变化：由于 Windows 上 Delete 键也触发 `key.delete=true` 但不产生 `\x1b[3~` 序列，会走退格逻辑。不过 Windows 用户极少在终端中使用 Delete 键，且后续可通过在 raw listener 中补充 Windows Delete 扫描码来完善。

### 为什么不直接 patch Ink？

1. Ink 是第三方依赖，patch 会在 `pnpm install` 时丢失或产生版本冲突
2. Ink 的注释表明会在下个 major 版本修复，patch 当前版本会增加维护负担
3. 在应用层兼容更可控，且不影响 Ink 的其他内部行为

---

## 经验总结

### 1. 终端按键解析不可信赖框架默认行为

终端（TTY）层面的按键编码有严重的平台碎片化：
- Backspace: `\b`(Windows) vs `\x7f`(Linux/Mac)
- Home/End: `\x1b[H`/`\x1b[F`(xterm) vs `\x1b[1~`/`\x1b[4~`(rxvt) vs `\xe047`/`\xe04f`(Windows CMD)
- Delete: `\x1b[3~` 是跨平台统一的，但 `\x7f` 被 Ink 错误映射

**教训**：涉及键盘输入的 CLI 应用，必须在真实 Linux/Mac 终端上验证核心按键行为，不能只在 Windows 上测试。

### 2. React 异步状态更新 vs 同步按键处理的竞态

`isStreaming` 通过 `setIsStreaming(false)` 更新，但 React 状态在下一个 render cycle 才生效。在 `abort()` 到 state 更新之间的时间窗口内，所有依赖 `isStreaming` 的条件判断都会得到**过期值**。

**教训**：关键退出路径不应依赖 React 异步状态。`lastCtrlCRef`（useRef，同步读写）是正确的选择；`isStreaming`（useState，异步更新）不适合做退出决策的前置条件。

### 3. process.exit(0) vs Ink exit() 的退出可靠性

Ink 的 `useApp().exit()` 是异步卸载流程，需要等所有 effect cleanup、timer、pending render 完成。在以下场景容易挂起：
- setInterval 未清理
- 进行中的 AbortController 未完全 settle
- stdin raw mode 未恢复

`process.exit(0)` 是同步强制退出，`process.on('exit')` 注册的清理回调仍会执行（同步部分），是更可靠的退出手段。

### 4. prependListener + flag 模式处理事件优先级

Node.js EventEmitter 没有 `stopPropagation`，无法在一个 listener 中阻止其他 listener 接收同一事件。`prependListener` + `handledByRawRef` flag 是一个轻量级替代方案：
- raw listener 通过 `prependListener` 先执行，设 flag
- 后续 listener 检查 flag，已处理则跳过

这比 monkey-patch EventEmitter 或 fork Ink 源码要干净得多。
