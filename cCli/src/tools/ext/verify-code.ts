// src/tools/ext/verify-code.ts

/**
 * VerifyCodeTool — 代码验证工具（Reflection Layer 1）。
 *
 * LLM 主动调用，对文件执行类型检查 / lint 等验证。
 * 自动检测项目类型（TypeScript / Python / Rust / Go），运行对应的检查命令。
 * 默认注册为内置工具，零配置开箱即用。
 *
 * 与 PostToolUse Hook（Layer 2）互补：
 * - verify_code = LLM 主动调用的"建议性验证"
 * - PostToolUse Hook = 用户配置的"强制性验证"
 */

import type { Tool, ToolResult, ToolContext } from '../core/types.js'
import { existsSync } from 'node:fs'
import { join, extname, dirname } from 'node:path'
import { execaCommand } from 'execa'

/** 单个检查器的结果 */
interface CheckResult {
  checker: string
  success: boolean
  output: string
}

/** 检查器定义 */
interface Checker {
  name: string
  /** 项目配置文件（存在则启用该检查器） */
  configFile: string
  /** 执行命令模板，{file} 会被替换为文件路径 */
  command: string
  /** 命令超时（ms） */
  timeout: number
}

/** 按语言分组的检查器 */
const CHECKERS: Record<string, Checker[]> = {
  typescript: [
    { name: 'TypeScript', configFile: 'tsconfig.json', command: 'npx tsc --noEmit', timeout: 30000 },
  ],
  javascript: [
    { name: 'ESLint', configFile: '.eslintrc.json', command: 'npx eslint {file}', timeout: 15000 },
    { name: 'ESLint', configFile: '.eslintrc.js', command: 'npx eslint {file}', timeout: 15000 },
    { name: 'ESLint', configFile: '.eslintrc.cjs', command: 'npx eslint {file}', timeout: 15000 },
    { name: 'ESLint', configFile: 'eslint.config.js', command: 'npx eslint {file}', timeout: 15000 },
    { name: 'ESLint', configFile: 'eslint.config.mjs', command: 'npx eslint {file}', timeout: 15000 },
  ],
  python: [
    { name: 'Ruff', configFile: 'pyproject.toml', command: 'ruff check {file}', timeout: 10000 },
    { name: 'Ruff', configFile: 'ruff.toml', command: 'ruff check {file}', timeout: 10000 },
    { name: 'Mypy', configFile: 'mypy.ini', command: 'mypy {file}', timeout: 20000 },
  ],
  rust: [
    { name: 'Cargo Check', configFile: 'Cargo.toml', command: 'cargo check', timeout: 60000 },
  ],
  go: [
    { name: 'Go Vet', configFile: 'go.mod', command: 'go vet ./...', timeout: 30000 },
  ],
  java: [
    { name: 'Maven Compile', configFile: 'pom.xml', command: 'mvn compile -q', timeout: 60000 },
    { name: 'Gradle Compile', configFile: 'build.gradle', command: 'gradle compileJava -q', timeout: 60000 },
    { name: 'Gradle Compile', configFile: 'build.gradle.kts', command: 'gradle compileJava -q', timeout: 60000 },
  ],
}

/** 扩展名 → 语言映射 */
const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
}

/** 从文件路径向上查找项目根目录（包含配置文件的最近祖先目录） */
function findProjectRoot(filePath: string, configFile: string): string | null {
  let dir = dirname(filePath)
  const root = dirname(dir) === dir ? dir : undefined // 文件系统根
  for (let i = 0; i < 10; i++) { // 最多向上 10 层
    if (existsSync(join(dir, configFile))) return dir
    const parent = dirname(dir)
    if (parent === dir || parent === root) break
    dir = parent
  }
  return null
}

export class VerifyCodeTool implements Tool {
  readonly name = 'verify_code'
  readonly description =
    'Run code verification on a file (type checking, linting, etc). ' +
    'Auto-detects project type from file extension and project config. ' +
    'Use this after writing or editing code to catch errors early. ' +
    'Call proactively when you have made significant changes.'
  readonly dangerous = false
  readonly parameters = {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path of the file to verify' },
      check_type: {
        type: 'string',
        enum: ['auto', 'typescript', 'javascript', 'python', 'rust', 'go', 'java'],
        description: 'Type of check to run. Default "auto" detects from file extension.',
      },
    },
    required: ['file_path'],
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const filePath = String(args['file_path'] ?? '')
    const checkType = String(args['check_type'] ?? 'auto')

    if (!filePath) {
      return { success: false, output: '', error: 'file_path is required' }
    }

    // 解析绝对路径
    const absPath = filePath.startsWith('/') || /^[a-zA-Z]:/.test(filePath)
      ? filePath
      : join(ctx.cwd, filePath)

    if (!existsSync(absPath)) {
      return { success: false, output: '', error: `文件不存在: ${filePath}` }
    }

    // 确定语言
    const lang = checkType === 'auto'
      ? EXT_TO_LANG[extname(absPath).toLowerCase()]
      : checkType

    if (!lang || !CHECKERS[lang]) {
      return {
        success: true,
        output: `⚠ No supported checker found for ${extname(absPath) || 'this file type'}. ` +
          `Supported: ${Object.keys(EXT_TO_LANG).join(', ')}`,
      }
    }

    // 查找可用的检查器（项目配置文件存在才启用）
    const availableCheckers: Array<{ checker: Checker; projectRoot: string }> = []
    const seenNames = new Set<string>()

    for (const checker of CHECKERS[lang]!) {
      if (seenNames.has(checker.name)) continue
      const root = findProjectRoot(absPath, checker.configFile)
      if (root) {
        availableCheckers.push({ checker, projectRoot: root })
        seenNames.add(checker.name)
      }
    }

    if (availableCheckers.length === 0) {
      return {
        success: true,
        output: `⚠ No project config found for ${lang} checks. ` +
          `Expected one of: ${CHECKERS[lang]!.map(c => c.configFile).join(', ')}`,
      }
    }

    // 逐个执行检查器
    const results: CheckResult[] = []

    for (const { checker, projectRoot } of availableCheckers) {
      const cmd = checker.command.replace(/\{file\}/g, absPath)
      try {
        const { stdout, stderr } = await execaCommand(cmd, {
          cwd: projectRoot,
          timeout: checker.timeout,
          reject: false,
          env: { ...process.env, FORCE_COLOR: '0' }, // 禁用颜色输出
        })
        const output = [stdout, stderr].filter(Boolean).join('\n').trim()
        // 判断成功：无输出或全是空行视为通过
        const hasErrors = output.length > 0 && !output.match(/^[\s\n]*$/)
        results.push({
          checker: checker.name,
          success: !hasErrors,
          output: hasErrors ? output : '',
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push({ checker: checker.name, success: false, output: msg })
      }
    }

    // 格式化输出
    const allPassed = results.every(r => r.success)
    const lines: string[] = []

    for (const r of results) {
      if (r.success) {
        lines.push(`✓ ${r.checker}: No errors found`)
      } else {
        // 截取前 30 行，避免输出过长
        const errorLines = r.output.split('\n')
        const preview = errorLines.slice(0, 30).join('\n')
        const remaining = errorLines.length - 30
        lines.push(`✗ ${r.checker}: errors found`)
        lines.push(preview)
        if (remaining > 0) lines.push(`  ... +${remaining} more lines`)
      }
    }

    return {
      success: allPassed,
      output: lines.join('\n'),
    }
  }
}
