import { resolve, normalize } from 'node:path'

/** @ 引用解析结果 */
export interface AtReference {
  /** 原始匹配文本，如 "@src/hooks/types.ts#10-20" */
  raw: string
  /** 相对路径（不含 # 行范围） */
  relativePath: string
  /** 绝对路径 */
  absolutePath: string
  /** 可选行范围 */
  lineRange?: { start: number; end?: number }
  /** 在输入中的起始偏移（指向 @ 字符） */
  startOffset: number
  /** 在输入中的结束偏移 */
  endOffset: number
}

/**
 * 匹配 @path 引用（支持 #行范围）。
 *
 * - (?:^|\s) — @ 前是空白或行首
 * - @ — 触发符
 * - ([\w./\\-]+) — 路径部分
 * - (?:#(\d+)(?:-(\d+))?)? — 可选 #line 或 #start-end
 *
 * 路径部分和行范围合在同一个捕获组里，解析时再拆分。
 */
const AT_PATTERN = /(?:^|\s)@([\w./\\-]+(?:#\d+(?:-\d+))?)/g

/**
 * 解析用户输入中的 @path 引用，生成 LLM context 提示。
 *
 * 不注入文件内容，仅告诉 LLM 文件位置，由 LLM 自行决定是否读取。
 */
export class AtResolver {
  constructor(private cwd: string) {}

  /**
   * 从用户输入中解析所有 @ 引用。
   */
  parse(input: string): AtReference[] {
    const results: AtReference[] = []

    // 每次调用需重置 lastIndex
    AT_PATTERN.lastIndex = 0

    let match: RegExpExecArray | null
    while ((match = AT_PATTERN.exec(input)) !== null) {
      const fullMatch = match[0]!
      const captured = match[1]!

      // @ 字符在 fullMatch 中的位置：可能前面有一个空白字符
      const leadingWhitespace = fullMatch.length - captured.length - 1 // -1 是 @ 本身
      const atOffset = match.index + leadingWhitespace

      // 拆分路径和行范围
      const hashIndex = captured.indexOf('#')
      let relativePath: string
      let lineRange: { start: number; end?: number } | undefined

      if (hashIndex !== -1) {
        relativePath = captured.slice(0, hashIndex)
        const lineSpec = captured.slice(hashIndex + 1)
        const dashIndex = lineSpec.indexOf('-')

        if (dashIndex !== -1) {
          const start = Number(lineSpec.slice(0, dashIndex))
          const end = Number(lineSpec.slice(dashIndex + 1))
          lineRange = { start, end }
        } else {
          lineRange = { start: Number(lineSpec) }
        }
      } else {
        relativePath = captured
      }

      // 规范化路径
      const normalizedRelative = normalize(relativePath)
      const absolutePath = resolve(this.cwd, normalizedRelative)

      const ref: AtReference = {
        raw: fullMatch.trimStart(), // 去掉前导空白，保留 @path
        relativePath: normalizedRelative,
        absolutePath,
        startOffset: atOffset,
        endOffset: atOffset + captured.length + 1, // +1 是 @ 字符
      }

      // exactOptionalPropertyTypes: 仅在有值时赋值
      if (lineRange) {
        ref.lineRange = lineRange
      }

      results.push(ref)
    }

    return results
  }

  /**
   * 生成注入给 LLM 的 context XML。
   *
   * 无引用时返回空字符串。
   */
  buildContext(refs: AtReference[]): string {
    if (refs.length === 0) return ''

    const lines = refs.map((ref) => {
      const attrs = [
        `path="${ref.relativePath}"`,
        `absolute="${ref.absolutePath}"`,
      ]

      if (ref.lineRange) {
        const lineStr = ref.lineRange.end != null
          ? `${ref.lineRange.start}-${ref.lineRange.end}`
          : `${ref.lineRange.start}`
        attrs.push(`lines="${lineStr}"`)
      }

      return `<file ${attrs.join(' ')} />`
    })

    return [
      '<file-references>',
      ...lines,
      '</file-references>',
    ].join('\n')
  }

  /**
   * 一步到位：解析 + 生成 context。
   *
   * @returns context — XML file-references 块（无引用时为空字符串）
   * @returns rawInput — 原始用户输入（不修改）
   */
  resolve(input: string): { context: string; rawInput: string } {
    const refs = this.parse(input)
    const context = this.buildContext(refs)
    return { context, rawInput: input }
  }
}
