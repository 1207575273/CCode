import React from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render } from 'ink-testing-library'
import { PermissionDialog } from '@ui/PermissionDialog.js'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const TMP = join(process.cwd(), '.tmp-perm-test')

// 每个测试前创建临时目录，测试后清理
beforeEach(() => {
  if (!existsSync(TMP)) {
    mkdirSync(TMP, { recursive: true })
  }
})

afterEach(() => {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true })
  }
})

const noop = () => {}

describe('PermissionDialog with diff', () => {
  it('should show diff for edit_file', () => {
    const filePath = join(TMP, 'edit-target.ts')
    writeFileSync(filePath, 'const foo = 1\nconst bar = 2\n', 'utf-8')

    const { lastFrame } = render(
      <PermissionDialog
        toolName="edit_file"
        args={{ path: filePath, old_str: 'const foo = 1', new_str: 'const foo = 42' }}
        onResolve={noop}
      />,
    )

    const output = lastFrame()!
    // 应该渲染 DiffView，包含 hunk header 和变更内容
    expect(output).toContain('@@')
    expect(output).toContain('foo = 1')
    expect(output).toContain('foo = 42')
  })

  it('should show diff for write_file overwrite', () => {
    const filePath = join(TMP, 'write-target.ts')
    writeFileSync(filePath, 'old content\n', 'utf-8')

    const { lastFrame } = render(
      <PermissionDialog
        toolName="write_file"
        args={{ path: filePath, content: 'new content\n' }}
        onResolve={noop}
      />,
    )

    const output = lastFrame()!
    expect(output).toContain('@@')
    expect(output).toContain('old content')
    expect(output).toContain('new content')
  })

  it('should show "Create file" title for new file write', () => {
    const filePath = join(TMP, 'brand-new.ts')
    // 不创建文件，让 computeWriteDiff 检测到是新文件

    const { lastFrame } = render(
      <PermissionDialog
        toolName="write_file"
        args={{ path: filePath, content: 'hello world\n' }}
        onResolve={noop}
      />,
    )

    const output = lastFrame()!
    expect(output).toContain('Create file')
    expect(output).toContain('(new)')
  })

  it('should not show diff for bash', () => {
    const { lastFrame } = render(
      <PermissionDialog
        toolName="bash"
        args={{ command: 'echo hello' }}
        onResolve={noop}
      />,
    )

    const output = lastFrame()!
    // bash 应该走原有 formatPreview 逻辑，不含 @@ 标记
    expect(output).toContain('echo hello')
    expect(output).not.toContain('@@')
    expect(output).toContain('Bash command')
  })
})
