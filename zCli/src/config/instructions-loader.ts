// src/config/instructions-loader.ts

/**
 * InstructionsLoader — 多层级指令文件（ZCLI.md / CLAUDE.md）发现与加载。
 *
 * 兼容 Claude Code 的 CLAUDE.md 生态：
 * - 每层优先查找 ZCLI.md，没有则 fallback 到 CLAUDE.md
 * - 同层只取一个文件，不会同时加载两个
 * - 一期为静态加载（启动时扫描），不做子目录懒加载
 *
 * 发现层级（优先级从高到低）：
 * 1. 全局用户级：~/.zcli/ZCLI.md → ~/.claude/CLAUDE.md
 * 2. 项目根：<git-root>/ZCLI.md → <git-root>/CLAUDE.md
 * 3. 项目配置目录：<git-root>/.zcli/ZCLI.md → <git-root>/.claude/CLAUDE.md
 * 4. 当前工作目录（若 ≠ git-root）：<cwd>/ZCLI.md → <cwd>/CLAUDE.md
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, normalize } from 'node:path'
import { homedir } from 'node:os'
import { execSync } from 'node:child_process'

/** 单条已加载指令的元信息 */
export interface LoadedInstruction {
  /** 来源文件的绝对路径 */
  source: string
  /** 层级标签：global / project / project-config / cwd */
  level: string
  /** 文件内容 */
  content: string
}

/** 每层尝试的文件名（优先 ZCLI.md） */
const CANDIDATE_NAMES = ['ZCLI.md', 'CLAUDE.md'] as const

/**
 * 获取 git 仓库根目录。
 * 失败时返回 null（不在 git 仓库中）。
 */
export function findGitRoot(cwd: string): string | null {
  try {
    const root = execSync('git rev-parse --show-toplevel', {
      cwd,
      encoding: 'utf-8',
      timeout: 3000,
      // 抑制 stderr 输出（非 git 目录时会打印错误）
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    return root ? normalize(root) : null
  } catch {
    return null
  }
}

/**
 * 在指定目录下查找指令文件（ZCLI.md 优先，fallback CLAUDE.md）。
 * 返回找到的文件绝对路径，没找到返回 null。
 */
function findInstructionFile(dir: string): string | null {
  for (const name of CANDIDATE_NAMES) {
    const filePath = join(dir, name)
    if (existsSync(filePath)) return filePath
  }
  return null
}

/**
 * 发现所有层级的指令文件路径（不读取内容）。
 * 自动去重：同一文件路径不会出现两次。
 */
export function discoverInstructionFiles(cwd: string): Array<{ path: string; level: string }> {
  const result: Array<{ path: string; level: string }> = []
  const seen = new Set<string>()

  const addIfFound = (dir: string, level: string) => {
    const found = findInstructionFile(dir)
    if (found) {
      const normalized = normalize(resolve(found))
      if (!seen.has(normalized)) {
        seen.add(normalized)
        result.push({ path: normalized, level })
      }
    }
  }

  // 层级 1：全局用户级
  addIfFound(join(homedir(), '.zcli'), 'global')
  addIfFound(join(homedir(), '.claude'), 'global')

  // 获取 git root
  const gitRoot = findGitRoot(cwd)
  const normalizedCwd = normalize(resolve(cwd))
  const normalizedGitRoot = gitRoot ? normalize(resolve(gitRoot)) : null

  if (normalizedGitRoot) {
    // 层级 2：项目根
    addIfFound(normalizedGitRoot, 'project')

    // 层级 3：项目配置目录
    addIfFound(join(normalizedGitRoot, '.zcli'), 'project-config')
    addIfFound(join(normalizedGitRoot, '.claude'), 'project-config')

    // 层级 4：当前工作目录（仅当 cwd ≠ git-root）
    if (normalizedCwd !== normalizedGitRoot) {
      addIfFound(normalizedCwd, 'cwd')
    }
  } else {
    // 不在 git 仓库中：cwd 作为项目根
    addIfFound(normalizedCwd, 'project')
    addIfFound(join(normalizedCwd, '.zcli'), 'project-config')
    addIfFound(join(normalizedCwd, '.claude'), 'project-config')
  }

  return result
}

/**
 * 加载所有层级的指令文件内容。
 * 读取失败的文件静默跳过（不阻塞启动）。
 */
export function loadInstructions(cwd: string): LoadedInstruction[] {
  const files = discoverInstructionFiles(cwd)
  const loaded: LoadedInstruction[] = []

  for (const { path: filePath, level } of files) {
    try {
      const content = readFileSync(filePath, 'utf-8').trim()
      if (content) {
        loaded.push({ source: filePath, level, content })
      }
    } catch {
      // 读取失败（权限问题等），静默跳过
    }
  }

  return loaded
}

/** system prompt 注入时每个指令文件的最大行数，超出部分截断并附加提示 */
const MAX_INSTRUCTION_LINES = 400

/**
 * 将已加载的指令格式化为 system prompt 段落。
 * 使用 <instructions> 标签包裹，便于 LLM 区分来源。
 *
 * 超过 MAX_INSTRUCTION_LINES 行的文件会被截断，末尾附加完整路径提示，
 * LLM 在需要时可通过 Read 工具自行加载完整内容。
 */
export function formatInstructionsPrompt(instructions: LoadedInstruction[]): string {
  if (instructions.length === 0) return ''

  return instructions
    .map(({ source, level, content }) => {
      const lines = content.split('\n')
      let body: string
      if (lines.length > MAX_INSTRUCTION_LINES) {
        body = lines.slice(0, MAX_INSTRUCTION_LINES).join('\n')
        body += `\n\n[... 已截断，共 ${lines.length} 行。需要完整内容时用 Read 工具读取: ${source}]`
      } else {
        body = content
      }
      return `<instructions source="${source}" level="${level}">\n${body}\n</instructions>`
    })
    .join('\n\n')
}
