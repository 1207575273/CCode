> 备注：项目原名 ZCli，2026-03-20 更名为 cCli（品牌名 CCode），详见 01_需求与项目管理核心文档/20260320030000_项目改名_ZCli到CCode.md

# CommandSuggestion Tab 补全 + 位置调整 — 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 建议浮层显示在输入框下方；Tab 和 Enter 均为补全到输入框，不直接执行指令。

**Architecture:** 仅修改 App.tsx 三处：useInput 逻辑、JSX 位置顺序，无需新增文件或改接口。

**Tech Stack:** React, Ink, TypeScript

---

### Task 1: 修改 App.tsx — Tab/Enter 补全逻辑 + 浮层位置

**Files:**
- Modify: `cCli/src/ui/App.tsx:170-197`（useInput 块）
- Modify: `cCli/src/ui/App.tsx:199-244`（JSX return 块）

---

**Step 1: 修改 useInput 的 Enter 分支 + 新增 Tab 分支**

当前 Enter 分支（lines 185-194）调用了 `handleSubmit`，需改为只补全输入框：

```typescript
// 旧逻辑（删除）
if (key.return) {
  const cmd = suggestions[suggestionIndexRef.current]
  if (cmd) {
    suggestionConsumedRef.current = true
    handleSubmit('/' + cmd.name)
    // DO NOT call setInputValue('') here — handleSubmit already does it
  }
}

// 新逻辑（替换）
if (key.tab || key.return) {
  const cmd = suggestions[suggestionIndexRef.current]
  if (cmd) {
    // suggestionConsumedRef: 阻断 TextInput.onSubmit 在同一 tick 触发 handleSubmit，
    // 防止将未完整输入（如 "/cl"）当作消息提交。
    // Tab 不触发 onSubmit，但与 return 共用同一分支，置 true 无副作用。
    suggestionConsumedRef.current = true
    setInputValue('/' + cmd.name + ' ')  // 尾部空格，方便继续输入参数
  }
}
```

完整替换后的 `useInput` 块如下（lines 169-197 整块替换）：

```typescript
  // isActive: 仅在浮层可见时拦截按键，防止与 TextInput 的正常 Enter 冲突
  useInput((_input, key) => {
    if (key.upArrow) {
      setSuggestionIndex(i => {
        const next = Math.max(0, i - 1)
        suggestionIndexRef.current = next
        return next
      })
    }
    if (key.downArrow) {
      setSuggestionIndex(i => {
        const next = Math.min(suggestions.length - 1, i + 1)
        suggestionIndexRef.current = next
        return next
      })
    }
    if (key.tab || key.return) {
      const cmd = suggestions[suggestionIndexRef.current]
      if (cmd) {
        // suggestionConsumedRef: 阻断 TextInput.onSubmit 在同一 tick 触发 handleSubmit，
        // 防止将未完整输入（如 "/cl"）当作消息提交。
        suggestionConsumedRef.current = true
        setInputValue('/' + cmd.name + ' ')  // 尾部空格，方便继续输入参数
      }
    }
    if (key.escape) setInputValue('')
  }, { isActive: suggestions.length > 0 })
```

---

**Step 2: 调整 JSX — 将 CommandSuggestion 移到 InputBar 下方**

当前 JSX（lines 213-215）`<CommandSuggestion>` 位于 InputBar 块上方，需移到下方。

目标结构（在 flexDirection="column" 的 Box 中，InputBar 块在上，建议列表在下）：

```tsx
  return (
    <Box flexDirection="column" width="100%">
      {started ? (
        <ChatView messages={messages} streamingMessage={streamingMessage} toolEvents={toolEvents} />
      ) : (
        <WelcomeScreen model={currentModel} provider={currentProvider} cwd={cwd} />
      )}

      {error != null && (
        <Box paddingX={1}>
          <Text color="red">✗ {error}</Text>
        </Box>
      )}

      {pendingPermission != null ? (
        <PermissionDialog
          toolName={pendingPermission.toolName}
          args={pendingPermission.args}
          onResolve={resolvePermission}
        />
      ) : showModelPicker ? (
        <ModelPicker
          currentProvider={currentProvider}
          currentModel={currentModel}
          items={modelItems}
          onSelect={(provider, model) => {
            switchModel(provider, model)
            appendSystemMessage(`已切换到 ${model} (${provider})`)
            setShowModelPicker(false)
          }}
          onCancel={() => setShowModelPicker(false)}
        />
      ) : (
        <InputBar
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          disabled={isStreaming}
        />
      )}

      {suggestions.length > 0 && (
        <CommandSuggestion items={suggestions} selectedIndex={suggestionIndex} />
      )}
    </Box>
  )
```

---

**Step 3: 运行 typecheck 和测试**

```bash
cd cCli && pnpm typecheck && pnpm test
```

预期：0 typecheck 错误，78 tests passed。

---

**Step 4: Commit**

```bash
git add cCli/src/ui/App.tsx
git commit -m "feat: CommandSuggestion 移至输入框下方 + Tab/Enter 改为补全模式"
```

---

## 验收标准

- 输入 `/` 后建议列表出现在**输入框下方**
- 按 Tab 或 Enter → 输入框填充为 `/cmdname `（有尾部空格），建议列表消失
- 填充后再按 Enter → 正常执行该指令
- 按 Esc → 清空输入，建议列表关闭
- 上下箭头仍可导航
- 78 个测试全绿，typecheck 无错误
