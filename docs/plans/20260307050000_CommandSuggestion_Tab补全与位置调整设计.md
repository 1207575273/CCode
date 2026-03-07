# CommandSuggestion Tab 补全 + 位置调整 — 设计文档

> 日期：2026-03-07

## 需求

1. 建议浮层显示在 InputBar **下方**（原为上方）
2. Tab 键：将高亮指令补全到输入框（`/{name} `，尾部留空格）
3. Enter 键（浮层可见时）：与 Tab 行为一致，补全到输入框，**不直接执行**
4. 补全后用户可继续输入参数，按 Enter 正常发送

## 交互流程

```
用户输入 "/cl"
  -> 浮层出现在 InputBar 下方，显示 /clear
  -> 按 Tab 或 Enter
  -> 输入框变为 "/clear "（尾部空格）
  -> 浮层消失（无前缀匹配）
  -> 用户按 Enter -> 正常执行
```

## 技术方案

### 位置调整

将 App.tsx JSX 中 `<CommandSuggestion>` 从 `<InputBar>` 上方移到下方。

### Tab / Enter 补全逻辑

```typescript
useInput((_input, key) => {
  if (key.upArrow)   { /* 同前 */ }
  if (key.downArrow) { /* 同前 */ }
  if (key.tab || key.return) {
    const cmd = suggestions[suggestionIndexRef.current]
    if (cmd) {
      suggestionConsumedRef.current = true   // 阻断 TextInput.onSubmit 二次触发
      setInputValue('/' + cmd.name + ' ')    // 补全，尾部空格方便继续输入
    }
  }
  if (key.escape) setInputValue('')
}, { isActive: suggestions.length > 0 })
```

### suggestionConsumedRef 保留原因

Enter 被 `useInput` 拦截补全后，TextInput 的 `onSubmit` 仍会在同一 tick 触发 `handleSubmit`。
ref 置 true 后 `handleSubmit` 检测到并提前返回，避免将未完整的指令（如 `/cl`）当作消息提交。

## 改动范围

| 文件 | 改动 |
|------|------|
| `src/ui/App.tsx` | 1) `useInput` Enter 分支改为补全逻辑；2) 新增 `key.tab` 分支（同逻辑）；3) JSX 位置调整 |

`CommandSuggestion.tsx` 无需修改。
