import React from 'react'
import { Text, Box } from 'ink'
import type { DiffHunk } from '@utils/compute-diff.js'

export interface DiffViewProps {
  filePath: string
  hunks: DiffHunk[]
  additions: number
  deletions: number
  isNewFile: boolean
  truncatedLines?: number | undefined
  error?: string | undefined
}

/** 纯展示组件：渲染 unified diff 输出 */
export function DiffView({
  filePath,
  hunks,
  additions,
  deletions,
  isNewFile,
  truncatedLines,
  error,
}: DiffViewProps): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {/* 文件路径头 */}
      <Text bold color="white">
        {filePath}
        {isNewFile ? <Text color="green"> (new)</Text> : null}
      </Text>

      {/* 错误回退 */}
      {error !== undefined ? (
        <Text dimColor>{error}</Text>
      ) : (
        <>
          {/* Hunks */}
          {hunks.map((hunk, hunkIndex) => (
            <Box key={hunkIndex} flexDirection="column">
              <Text dimColor>
                {`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}
              </Text>
              {hunk.lines.map((line, lineIndex) => {
                const prefix = line[0] ?? ' '
                const content = line.slice(1)

                if (prefix === '+') {
                  return (
                    <Text key={lineIndex} color="green">
                      {` +${content}`}
                    </Text>
                  )
                }
                if (prefix === '-') {
                  return (
                    <Text key={lineIndex} color="red">
                      {` -${content}`}
                    </Text>
                  )
                }
                // context line
                return (
                  <Text key={lineIndex} dimColor>
                    {`  ${content}`}
                  </Text>
                )
              })}
            </Box>
          ))}

          {/* 截断提示 */}
          {truncatedLines !== undefined && truncatedLines > 0 ? (
            <Text dimColor>{`... 还有 ${truncatedLines} 行未显示`}</Text>
          ) : null}

          {/* 统计行 */}
          <StatsLine additions={additions} deletions={deletions} />
        </>
      )}
    </Box>
  )
}

/** 增删统计行：只显示 > 0 的部分 */
function StatsLine({
  additions,
  deletions,
}: {
  additions: number
  deletions: number
}): React.JSX.Element | null {
  if (additions === 0 && deletions === 0) return null

  return (
    <Text>
      {additions > 0 ? <Text color="green">{`+${additions}`}</Text> : null}
      {additions > 0 && deletions > 0 ? <Text> </Text> : null}
      {deletions > 0 ? <Text color="red">{`-${deletions}`}</Text> : null}
    </Text>
  )
}
