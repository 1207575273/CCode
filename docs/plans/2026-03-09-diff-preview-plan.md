# Diff Preview 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 PermissionDialog 审批文件操作前展示 unified diff 预览，让用户看到具体变更。

**Architecture:** 新增 `diff` 依赖计算差异，新建 `DiffView` 纯展示组件渲染 unified diff，新建 `computeDiff` 工具函数读取原文件并计算 diff 数据，修改 `PermissionDialog` 在 edit_file/write_file 时调用计算并嵌入 DiffView。

**Tech Stack:** `diff` (jsdiff), React/Ink, TypeScript

---

### Task 1: 安装 diff 依赖

**Files:**
- Modify: `zCli/package.json`

**Step 1: 安装 diff 包和类型**

```bash
cd zCli && pnpm add diff && pnpm add -D @types/diff
```

**Step 2: 验证安装成功**

```bash
cd zCli && pnpm exec tsc --noEmit
```
Expected: 无报错

**Step 3: Commit**

```bash
git add zCli/package.json zCli/pnpm-lock.yaml
git commit -m "chore: add diff (jsdiff) dependency"
```

---

### Task 2: computeDiff 工具函数 + 测试

**Files:**
- Create: `zCli/src/utils/compute-diff.ts`
- Create: `zCli/tests/unit/compute-diff.test.ts`

**Step 1: 写失败测试**

```typescript
// tests/unit/compute-diff.test.ts
import { describe, it, expect } from 'vitest'
import { computeEditDiff, computeWriteDiff } from '@utils/compute-diff.js'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const TMP = join(process.cwd(), '.tmp-diff-test')

describe('computeEditDiff', () => {
  it('should_produce_hunks_when_replacing_string', () => {
    mkdirSync(TMP, { recursive: true })
    const file = join(TMP, 'edit.txt')
    writeFileSync(file, 'line1\nline2\nline3\n')

    const result = computeEditDiff(file, 'line2', 'lineB')

    expect(result.hunks.length).toBeGreaterThan(0)
    expect(result.additions).toBe(1)
    expect(result.deletions).toBe(1)
    expect(result.isNewFile).toBe(false)

    rmSync(TMP, { recursive: true, force: true })
  })

  it('should_return_error_when_file_not_found', () => {
    const result = computeEditDiff('/nonexistent/path.txt', 'a', 'b')
    expect(result.error).toBeDefined()
    expect(result.hunks).toEqual([])
  })
})

describe('computeWriteDiff', () => {
  it('should_show_full_add_when_file_is_new', () => {
    const result = computeWriteDiff(join(TMP, 'new.txt'), 'hello\nworld\n')

    expect(result.isNewFile).toBe(true)
    expect(result.additions).toBe(2)
    expect(result.deletions).toBe(0)
  })

  it('should_show_diff_when_overwriting_existing', () => {
    mkdirSync(TMP, { recursive: true })
    const file = join(TMP, 'overwrite.txt')
    writeFileSync(file, 'old content\n')

    const result = computeWriteDiff(file, 'new content\n')

    expect(result.isNewFile).toBe(false)
    expect(result.hunks.length).toBeGreaterThan(0)
    expect(result.additions).toBeGreaterThanOrEqual(1)
    expect(result.deletions).toBeGreaterThanOrEqual(1)

    rmSync(TMP, { recursive: true, force: true })
  })

  it('should_truncate_new_file_over_20_lines', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n') + '\n'
    const result = computeWriteDiff(join(TMP, 'big.txt'), lines)

    expect(result.isNewFile).toBe(true)
    expect(result.truncatedLines).toBe(10)
  })
})
```

**Step 2: 运行测试确认红灯**

```bash
cd zCli && pnpm test -- tests/unit/compute-diff.test.ts
```
Expected: FAIL（模块不存在）

**Step 3: 实现 computeDiff**

```typescript
// src/utils/compute-diff.ts
import { readFileSync, existsSync } from 'node:fs'
import { structuredPatch } from 'diff'

const MAX_HUNKS = 5
const NEW_FILE_MAX_LINES = 20

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]  // 每行带 +/- /空格 前缀
}

export interface DiffData {
  filePath: string
  hunks: DiffHunk[]
  additions: number
  deletions: number
  isNewFile: boolean
  truncatedLines?: number
  error?: string
}

function isBinary(buffer: Buffer): boolean {
  for (let i = 0; i < Math.min(buffer.length, 8000); i++) {
    if (buffer[i] === 0) return true
  }
  return false
}

function computePatch(filePath: string, oldStr: string, newStr: string, isNewFile: boolean): DiffData {
  const patch = structuredPatch(filePath, filePath, oldStr, newStr, '', '', { context: 3 })

  let additions = 0
  let deletions = 0
  const hunks: DiffHunk[] = []

  for (const h of patch.hunks.slice(0, MAX_HUNKS)) {
    const lines: string[] = h.lines
    for (const line of lines) {
      if (line.startsWith('+')) additions++
      else if (line.startsWith('-')) deletions++
    }
    hunks.push({
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines,
    })
  }

  const truncatedHunks = patch.hunks.length > MAX_HUNKS ? patch.hunks.length - MAX_HUNKS : undefined

  return {
    filePath,
    hunks,
    additions,
    deletions,
    isNewFile,
    ...(truncatedHunks != null ? { truncatedLines: truncatedHunks } : {}),
  }
}

/** edit_file 场景：读原文件 → 替换 old_str → 计算 diff */
export function computeEditDiff(filePath: string, oldStr: string, newStr: string): DiffData {
  try {
    if (!existsSync(filePath)) {
      return { filePath, hunks: [], additions: 0, deletions: 0, isNewFile: false, error: `文件不存在: ${filePath}` }
    }
    const buf = readFileSync(filePath)
    if (isBinary(buf)) {
      return { filePath, hunks: [], additions: 0, deletions: 0, isNewFile: false, error: `Binary file, ${buf.length} bytes` }
    }
    const original = buf.toString('utf-8')
    const updated = original.replace(oldStr, newStr)
    return computePatch(filePath, original, updated, false)
  } catch (err) {
    return { filePath, hunks: [], additions: 0, deletions: 0, isNewFile: false, error: String(err) }
  }
}

/** write_file 场景：读原文件（可能不存在）→ 对比新内容 */
export function computeWriteDiff(filePath: string, newContent: string): DiffData {
  try {
    let original = ''
    let isNewFile = true

    if (existsSync(filePath)) {
      const buf = readFileSync(filePath)
      if (isBinary(buf)) {
        return { filePath, hunks: [], additions: 0, deletions: 0, isNewFile: false, error: `Binary file, ${buf.length} bytes` }
      }
      original = buf.toString('utf-8')
      isNewFile = false
    }

    // 新建文件 > 20 行时截断
    if (isNewFile) {
      const lines = newContent.split('\n')
      // 末尾空行不算
      const realLines = newContent.endsWith('\n') ? lines.length - 1 : lines.length
      if (realLines > NEW_FILE_MAX_LINES) {
        const truncated = lines.slice(0, NEW_FILE_MAX_LINES).join('\n') + '\n'
        const result = computePatch(filePath, '', truncated, true)
        result.truncatedLines = realLines - NEW_FILE_MAX_LINES
        return result
      }
    }

    return computePatch(filePath, original, newContent, isNewFile)
  } catch (err) {
    return { filePath, hunks: [], additions: 0, deletions: 0, isNewFile: true, error: String(err) }
  }
}
```

**Step 4: 运行测试确认绿灯**

```bash
cd zCli && pnpm test -- tests/unit/compute-diff.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add zCli/src/utils/compute-diff.ts zCli/tests/unit/compute-diff.test.ts
git commit -m "feat: computeEditDiff / computeWriteDiff 工具函数 + 测试"
```

---

### Task 3: DiffView 纯展示组件 + 测试

**Files:**
- Create: `zCli/src/ui/DiffView.tsx`
- Create: `zCli/tests/unit/diff-view.test.tsx`

**Step 1: 写失败测试**

```typescript
// tests/unit/diff-view.test.tsx
import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { DiffView } from '@ui/DiffView.js'
import type { DiffHunk } from '@utils/compute-diff.js'

describe('DiffView', () => {
  it('should_render_hunk_with_additions_and_deletions', () => {
    const hunks: DiffHunk[] = [{
      oldStart: 1, oldLines: 3, newStart: 1, newLines: 3,
      lines: [' line1', '-line2', '+lineB', ' line3'],
    }]

    const { lastFrame } = render(
      <DiffView filePath="test.txt" hunks={hunks} additions={1} deletions={1} isNewFile={false} />
    )
    const output = lastFrame()!
    expect(output).toContain('test.txt')
    expect(output).toContain('line2')
    expect(output).toContain('lineB')
    expect(output).toContain('+1')
    expect(output).toContain('-1')
  })

  it('should_show_new_file_label', () => {
    const hunks: DiffHunk[] = [{
      oldStart: 0, oldLines: 0, newStart: 1, newLines: 1,
      lines: ['+hello'],
    }]

    const { lastFrame } = render(
      <DiffView filePath="new.txt" hunks={hunks} additions={1} deletions={0} isNewFile={true} />
    )
    expect(lastFrame()!).toContain('new')
  })

  it('should_show_truncation_hint', () => {
    const { lastFrame } = render(
      <DiffView filePath="big.txt" hunks={[]} additions={20} deletions={0} isNewFile={true} truncatedLines={10} />
    )
    expect(lastFrame()!).toContain('10')
  })

  it('should_show_error_fallback', () => {
    const { lastFrame } = render(
      <DiffView filePath="err.txt" hunks={[]} additions={0} deletions={0} isNewFile={false} error="Binary file, 1024 bytes" />
    )
    expect(lastFrame()!).toContain('Binary')
  })
})
```

**Step 2: 运行测试确认红灯**

```bash
cd zCli && pnpm test -- tests/unit/diff-view.test.tsx
```
Expected: FAIL

**Step 3: 实现 DiffView**

```tsx
// src/ui/DiffView.tsx
import React from 'react'
import { Box, Text } from 'ink'
import type { DiffHunk } from '@utils/compute-diff.js'

interface DiffViewProps {
  filePath: string
  hunks: DiffHunk[]
  additions: number
  deletions: number
  isNewFile: boolean
  truncatedLines?: number
  error?: string
}

export function DiffView({ filePath, hunks, additions, deletions, isNewFile, truncatedLines, error }: DiffViewProps) {
  return (
    <Box flexDirection="column">
      {/* 文件路径 */}
      <Box>
        <Text bold color="white"> {filePath}</Text>
        {isNewFile && <Text color="green"> (new)</Text>}
      </Box>

      {/* 错误降级 */}
      {error != null ? (
        <Box paddingLeft={2} marginY={1}>
          <Text dimColor>{error}</Text>
        </Box>
      ) : (
        <>
          {/* Hunks */}
          {hunks.map((hunk, hi) => (
            <Box key={hi} flexDirection="column" marginTop={hi > 0 ? 1 : 0}>
              <Text dimColor> @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</Text>
              {hunk.lines.map((line, li) => {
                const prefix = line[0] ?? ' '
                const content = line.slice(1)
                if (prefix === '+') {
                  return <Text key={li} color="green"> +{content}</Text>
                }
                if (prefix === '-') {
                  return <Text key={li} color="red"> -{content}</Text>
                }
                return <Text key={li} dimColor>  {content}</Text>
              })}
            </Box>
          ))}

          {/* 截断提示 */}
          {truncatedLines != null && truncatedLines > 0 && (
            <Box paddingLeft={2}>
              <Text dimColor>... 还有 {truncatedLines} 行未显示</Text>
            </Box>
          )}

          {/* 变更统计 */}
          <Box marginTop={1}>
            {additions > 0 && <Text color="green"> +{additions}</Text>}
            {deletions > 0 && <Text color="red"> -{deletions}</Text>}
          </Box>
        </>
      )}
    </Box>
  )
}
```

**Step 4: 运行测试确认绿灯**

```bash
cd zCli && pnpm test -- tests/unit/diff-view.test.tsx
```
Expected: PASS

**Step 5: Commit**

```bash
git add zCli/src/ui/DiffView.tsx zCli/tests/unit/diff-view.test.tsx
git commit -m "feat: DiffView 纯展示组件 + 测试"
```

---

### Task 4: 修改 PermissionDialog 集成 DiffView

**Files:**
- Modify: `zCli/src/ui/PermissionDialog.tsx`
- Create: `zCli/tests/unit/permission-dialog-diff.test.tsx`

**Step 1: 写失败测试**

```typescript
// tests/unit/permission-dialog-diff.test.tsx
import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { PermissionDialog } from '@ui/PermissionDialog.js'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const TMP = join(process.cwd(), '.tmp-perm-test')

describe('PermissionDialog with diff', () => {
  it('should_show_diff_for_edit_file', () => {
    mkdirSync(TMP, { recursive: true })
    const file = join(TMP, 'edit.txt')
    writeFileSync(file, 'aaa\nbbb\nccc\n')

    const { lastFrame } = render(
      <PermissionDialog
        toolName="edit_file"
        args={{ path: file, old_str: 'bbb', new_str: 'BBB' }}
        onResolve={() => {}}
      />
    )
    const output = lastFrame()!
    expect(output).toContain('bbb')
    expect(output).toContain('BBB')

    rmSync(TMP, { recursive: true, force: true })
  })

  it('should_show_diff_for_write_file_overwrite', () => {
    mkdirSync(TMP, { recursive: true })
    const file = join(TMP, 'write.txt')
    writeFileSync(file, 'old\n')

    const { lastFrame } = render(
      <PermissionDialog
        toolName="write_file"
        args={{ path: file, content: 'new\n' }}
        onResolve={() => {}}
      />
    )
    const output = lastFrame()!
    expect(output).toContain('old')
    expect(output).toContain('new')

    rmSync(TMP, { recursive: true, force: true })
  })

  it('should_not_show_diff_for_bash', () => {
    const { lastFrame } = render(
      <PermissionDialog
        toolName="bash"
        args={{ command: 'echo hello' }}
        onResolve={() => {}}
      />
    )
    const output = lastFrame()!
    expect(output).toContain('echo hello')
    // bash 不应出现 @@ 行号标记
    expect(output).not.toContain('@@')
  })
})
```

**Step 2: 运行测试确认红灯**

```bash
cd zCli && pnpm test -- tests/unit/permission-dialog-diff.test.tsx
```
Expected: FAIL（PermissionDialog 未渲染 diff）

**Step 3: 修改 PermissionDialog**

修改 `zCli/src/ui/PermissionDialog.tsx`，关键变更：

1. import `DiffView` 和 `computeEditDiff` / `computeWriteDiff`
2. 在组件顶层用 `useMemo` 计算 diff 数据（仅 edit_file / write_file 时）
3. 有 diff 数据时渲染 DiffView 替代原有 preview 文本
4. 无 diff 时保持原有行为（bash 等工具）
5. 更新标题映射：write_file 新建时显示 "Create file"，覆盖时 "Write file"

```tsx
// PermissionDialog 核心修改（非完整文件，标注变更部分）

import { useMemo } from 'react'
import { DiffView } from './DiffView.js'
import { computeEditDiff, computeWriteDiff } from '@utils/compute-diff.js'
import type { DiffData } from '@utils/compute-diff.js'
import { resolve } from 'node:path'

// 在组件函数内：
const diffData: DiffData | null = useMemo(() => {
  const rawPath = String(args['path'] ?? '')
  const filePath = resolve(process.cwd(), rawPath)

  if (toolName === 'edit_file') {
    return computeEditDiff(filePath, String(args['old_str'] ?? ''), String(args['new_str'] ?? ''))
  }
  if (toolName === 'write_file') {
    return computeWriteDiff(filePath, String(args['content'] ?? ''))
  }
  return null
}, [toolName, args])

// title 逻辑更新：
const title = diffData?.isNewFile ? 'Create file' : (TOOL_TITLES[toolName] ?? toolName)

// render 中：diffData 存在时用 DiffView，否则用原有 preview
{diffData != null ? (
  <Box marginY={1}>
    <DiffView {...diffData} />
  </Box>
) : (
  <Box marginY={1} paddingLeft={2}>
    <Text dimColor>{preview}</Text>
  </Box>
)}
```

**Step 4: 运行全部测试确认绿灯**

```bash
cd zCli && pnpm test
```
Expected: 全部 PASS

**Step 5: TypeScript 类型检查**

```bash
cd zCli && pnpm exec tsc --noEmit
```
Expected: 无报错

**Step 6: Commit**

```bash
git add zCli/src/ui/PermissionDialog.tsx zCli/tests/unit/permission-dialog-diff.test.tsx
git commit -m "feat: PermissionDialog 集成 DiffView 预览"
```

---

### Task 5: 全量回归 + 推送

**Step 1: 全量测试**

```bash
cd zCli && pnpm test
```
Expected: 全部 PASS

**Step 2: 手动验收**

```bash
cd zCli && pnpm dev
```
测试场景：
- 让 AI 执行 edit_file → 应看到 unified diff + 审批选项
- 让 AI 执行 write_file 新建 → 应看到绿色新增行 + (new) 标签
- 让 AI 执行 write_file 覆盖 → 应看到红绿对比
- 让 AI 执行 bash → 应看到原有命令预览（无 diff）

**Step 3: 推送**

```bash
git push origin main
```
