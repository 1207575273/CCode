import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import { DiffView } from '@ui/DiffView.js'
import type { DiffHunk } from '@utils/compute-diff.js'

describe('DiffView', () => {
  const makeHunk = (overrides: Partial<DiffHunk> = {}): DiffHunk => ({
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 3,
    lines: [' context line', '-old line', '+new line'],
    ...overrides,
  })

  it('should render hunk with additions and deletions and show stats', () => {
    const hunks: DiffHunk[] = [makeHunk()]
    const { lastFrame } = render(
      <DiffView
        filePath="src/foo.ts"
        hunks={hunks}
        additions={1}
        deletions={1}
        isNewFile={false}
      />,
    )

    const output = lastFrame()!
    // hunk header
    expect(output).toContain('@@ -1,3 +1,3 @@')
    // diff content
    expect(output).toContain('old line')
    expect(output).toContain('new line')
    // stats
    expect(output).toContain('+1')
    expect(output).toContain('-1')
    // file path
    expect(output).toContain('src/foo.ts')
  })

  it('should show "(new)" label for new files', () => {
    const { lastFrame } = render(
      <DiffView
        filePath="src/bar.ts"
        hunks={[makeHunk({ lines: ['+added line'] })]}
        additions={1}
        deletions={0}
        isNewFile={true}
      />,
    )

    const output = lastFrame()!
    expect(output).toContain('src/bar.ts')
    expect(output).toContain('(new)')
  })

  it('should show truncation hint when truncatedLines is set', () => {
    const { lastFrame } = render(
      <DiffView
        filePath="src/big.ts"
        hunks={[makeHunk()]}
        additions={1}
        deletions={1}
        isNewFile={true}
        truncatedLines={42}
      />,
    )

    const output = lastFrame()!
    expect(output).toContain('42')
    expect(output).toContain('未显示')
  })

  it('should show error fallback text instead of hunks', () => {
    const { lastFrame } = render(
      <DiffView
        filePath="src/broken.bin"
        hunks={[]}
        additions={0}
        deletions={0}
        isNewFile={false}
        error="Binary file — diff not available"
      />,
    )

    const output = lastFrame()!
    expect(output).toContain('Binary file')
    expect(output).toContain('src/broken.bin')
    // should NOT contain hunk header since error is shown
    expect(output).not.toContain('@@')
  })
})
