// src/tools/core/git.ts — Git 工具，提供 13 个子命令覆盖日常 Git 操作
import { execa } from 'execa'
import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Tool, ToolContext, ToolResult } from './types.js'

/** diff / show 截断行数上限（多文件） */
const TRUNCATE_LINES_MULTI = 2000
/** diff / show 截断行数上限（单文件） */
const TRUNCATE_LINES_SINGLE = 3000
/** log 默认返回条数 */
const LOG_DEFAULT_COUNT = 10
/** log 最大返回条数 */
const LOG_MAX_COUNT = 50

/** 敏感文件名模式 — commit 时禁止暂存 */
const SENSITIVE_PATTERNS = [
  /\.env$/i,
  /\.env\..+$/i,
  /credentials\.json$/i,
  /\.secret$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.pem$/i,
  /\.key$/i,
]

/**
 * 截断输出辅助函数
 * @param output 原始输出
 * @param maxLines 最大行数
 * @param hint 截断提示信息
 */
function truncateOutput(output: string, maxLines: number, hint: string): string {
  const lines = output.split('\n')
  if (lines.length <= maxLines) return output
  return lines.slice(0, maxLines).join('\n') + `\n\n... [已截断，共 ${lines.length} 行，仅显示前 ${maxLines} 行] ${hint}`
}

/** 检测文件名是否命中敏感模式 */
function isSensitiveFile(filePath: string): boolean {
  const name = filePath.replace(/\\/g, '/').split('/').pop() ?? ''
  return SENSITIVE_PATTERNS.some((p) => p.test(name))
}

export class GitTool implements Tool {
  readonly name = 'git'
  readonly dangerous = true
  readonly description = [
    '执行 Git 操作。支持以下 13 个子命令：',
    '',
    '• status  — 查看工作区状态（分支、暂存/未暂存/未跟踪文件）',
    '• diff    — 查看变更差异（支持 --staged 和指定文件）',
    '• log     — 查看提交历史（支持数量限制和作者过滤）',
    '• branch  — 列出所有分支（含远程分支和上游信息）',
    '• show    — 查看某次提交的详情或指定文件内容',
    '• checkout — 切换分支或创建新分支',
    '• commit  — 暂存文件并提交（必须指定文件列表，自动拦截敏感文件）',
    '• merge   — 合并目标分支到当前分支',
    '• rebase  — 变基到目标分支',
    '• cherry_pick — 拣选指定提交到当前分支',
    '• stash   — 暂存/恢复/列出/删除工作区变更',
    '• tag     — 列出/创建/删除标签',
    '• reset   — 重置 HEAD 到指定提交（支持 soft/mixed/hard 模式）',
    '',
    '所有子命令均在当前工作目录执行，操作前会校验是否为 Git 仓库。',
  ].join('\n')

  readonly parameters = {
    type: 'object',
    properties: {
      subcommand: {
        type: 'string',
        enum: [
          'status', 'diff', 'log', 'branch', 'show',
          'checkout', 'commit', 'merge', 'rebase', 'cherry_pick',
          'stash', 'tag', 'reset',
        ],
        description: '子命令类型',
      },
      file: { type: 'string', description: '[diff/show] 指定文件路径（可选，默认全部文件）' },
      staged: { type: 'boolean', description: '[diff] 仅查看已暂存的变更（默认 false）' },
      count: { type: 'number', description: '[log] 返回的提交数量（默认 10，最大 50）' },
      author: { type: 'string', description: '[log] 按作者过滤' },
      ref: { type: 'string', description: '[show/cherry_pick/reset] 指定 commit hash 或引用' },
      branch_name: { type: 'string', description: '[checkout] 切换到的分支名' },
      create_branch: { type: 'boolean', description: '[checkout] 是否创建新分支（默认 false）' },
      message: { type: 'string', description: '[commit/tag] 提交信息或 tag 注释' },
      files: { type: 'array', items: { type: 'string' }, description: '[commit] 指定暂存的文件列表（必填）' },
      target: { type: 'string', description: '[merge/rebase] 目标分支名' },
      abort: { type: 'boolean', description: '[merge/rebase/cherry_pick] 冲突时中止操作' },
      mode: { type: 'string', enum: ['soft', 'mixed', 'hard'], description: '[reset] 重置模式（默认 mixed）' },
      stash_action: { type: 'string', enum: ['push', 'pop', 'list', 'drop'], description: '[stash] 操作类型（默认 push）' },
      stash_message: { type: 'string', description: '[stash] push 时的描述信息' },
      tag_name: { type: 'string', description: '[tag] 标签名称' },
      tag_delete: { type: 'boolean', description: '[tag] 删除标签（默认 false）' },
    },
    required: ['subcommand'],
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const cwd = ctx.cwd

    // 前置校验：是否在 Git 仓库内
    try {
      await execa('git', ['rev-parse', '--is-inside-work-tree'], { cwd })
    } catch {
      return {
        success: false,
        output: '',
        error: '当前目录不是 Git 仓库。请先执行 git init 初始化，或 cd 到一个 Git 仓库目录。',
      }
    }

    const subcommand = String(args['subcommand'] ?? '')

    // 子命令路由
    const handlers: Record<string, () => Promise<ToolResult>> = {
      status: () => this.#handleStatus(cwd),
      diff: () => this.#handleDiff(args, cwd),
      log: () => this.#handleLog(args, cwd),
      branch: () => this.#handleBranch(cwd),
      show: () => this.#handleShow(args, cwd),
      checkout: () => this.#handleCheckout(args, cwd),
      commit: () => this.#handleCommit(args, cwd),
      merge: () => this.#handleMerge(args, cwd),
      rebase: () => this.#handleRebase(args, cwd),
      cherry_pick: () => this.#handleCherryPick(args, cwd),
      stash: () => this.#handleStash(args, cwd),
      tag: () => this.#handleTag(args, cwd),
      reset: () => this.#handleReset(args, cwd),
    }

    const handler = handlers[subcommand]
    if (!handler) {
      return { success: false, output: '', error: `未知子命令: ${subcommand}` }
    }

    return handler()
  }

  // ─── status ───────────────────────────────────────────
  async #handleStatus(cwd: string): Promise<ToolResult> {
    const result = await execa('git', ['status', '--short', '--branch'], { cwd, reject: false })
    if (result.exitCode !== 0) {
      return { success: false, output: '', error: result.stderr || `git status 失败（exitCode=${result.exitCode}）` }
    }
    const lines = result.stdout.split('\n').filter(Boolean)

    // 第一行是分支信息
    const branchLine = lines[0] ?? ''
    const fileLines = lines.slice(1)

    let staged = 0
    let unstaged = 0
    let untracked = 0

    for (const line of fileLines) {
      const x = line[0] ?? ' '
      const y = line[1] ?? ' '
      if (x === '?') {
        untracked++
      } else {
        if (x !== ' ' && x !== '?') staged++
        if (y !== ' ' && y !== '?') unstaged++
      }
    }

    const summary = [
      branchLine,
      '',
      `已暂存: ${staged}  未暂存: ${unstaged}  未跟踪: ${untracked}`,
      '',
      ...fileLines,
    ].join('\n')

    return { success: true, output: summary || '工作区干净，无任何变更。' }
  }

  // ─── diff ─────────────────────────────────────────────
  async #handleDiff(args: Record<string, unknown>, cwd: string): Promise<ToolResult> {
    const staged = args['staged'] === true
    const file = args['file'] as string | undefined

    const diffArgs = ['diff']
    if (staged) diffArgs.push('--staged')
    if (file) diffArgs.push('--', file)

    const result = await execa('git', diffArgs, { cwd, reject: false })
    if (!result.stdout.trim()) {
      return { success: true, output: staged ? '暂存区无变更。' : '工作区无变更。' }
    }

    const maxLines = file ? TRUNCATE_LINES_SINGLE : TRUNCATE_LINES_MULTI
    let output = result.stdout

    if (output.split('\n').length > maxLines) {
      // 截断时追加 stat 摘要（独立构建 statArgs，不依赖 diffArgs 切片）
      const statArgs = ['diff', '--stat']
      if (staged) statArgs.push('--staged')
      if (file) statArgs.push('--', file)
      const statResult = await execa('git', statArgs, { cwd, reject: false })
      output = truncateOutput(output, maxLines, '\n\n--- diff 统计摘要 ---\n' + statResult.stdout)
    }

    return { success: true, output }
  }

  // ─── log ──────────────────────────────────────────────
  async #handleLog(args: Record<string, unknown>, cwd: string): Promise<ToolResult> {
    const rawCount = Number(args['count'])
    const count = Number.isFinite(rawCount) && rawCount > 0
      ? Math.min(Math.round(rawCount), LOG_MAX_COUNT)
      : LOG_DEFAULT_COUNT
    const author = args['author'] as string | undefined

    const logArgs = ['log', `--format=%h %ad %an | %s`, '--date=short', `-${count}`]
    if (author) logArgs.push(`--author=${author}`)

    const result = await execa('git', logArgs, { cwd, reject: false })
    if (result.exitCode !== 0) {
      return { success: false, output: '', error: result.stderr || '获取日志失败。' }
    }

    return { success: true, output: result.stdout || '暂无提交记录。' }
  }

  // ─── branch ───────────────────────────────────────────
  async #handleBranch(cwd: string): Promise<ToolResult> {
    const result = await execa(
      'git', ['branch', '-a', '--format=%(if)%(HEAD)%(then)* %(end)%(refname:short)'],
      { cwd, reject: false },
    )

    // 追加上游信息
    const upstreamResult = await execa(
      'git', ['for-each-ref', '--format=%(refname:short) -> %(upstream:short)', 'refs/heads/'],
      { cwd, reject: false },
    )

    const output = [result.stdout, '', '--- 上游追踪 ---', upstreamResult.stdout].filter(Boolean).join('\n')
    return { success: true, output: output || '暂无分支。' }
  }

  // ─── show ─────────────────────────────────────────────
  async #handleShow(args: Record<string, unknown>, cwd: string): Promise<ToolResult> {
    const ref = (args['ref'] as string | undefined) ?? 'HEAD'
    const file = args['file'] as string | undefined

    const showArgs = file
      ? ['show', ref, '--', file]
      : ['show', '--stat', ref]

    const result = await execa('git', showArgs, { cwd, reject: false })
    if (result.exitCode !== 0) {
      return { success: false, output: '', error: result.stderr || `查看 ${ref} 失败。` }
    }

    const maxLines = file ? TRUNCATE_LINES_SINGLE : TRUNCATE_LINES_MULTI
    const output = truncateOutput(result.stdout, maxLines, '')
    return { success: true, output }
  }

  // ─── checkout ─────────────────────────────────────────
  async #handleCheckout(args: Record<string, unknown>, cwd: string): Promise<ToolResult> {
    const branchName = args['branch_name'] as string | undefined
    if (!branchName) {
      return { success: false, output: '', error: 'checkout 需要指定 branch_name 参数。' }
    }

    const createBranch = args['create_branch'] === true
    const checkoutArgs = createBranch
      ? ['checkout', '-b', branchName]
      : ['checkout', branchName]

    const result = await execa('git', checkoutArgs, { cwd, reject: false })
    if (result.exitCode !== 0) {
      return { success: false, output: '', error: result.stderr || `切换到 ${branchName} 失败。` }
    }

    return { success: true, output: result.stderr || result.stdout || `已切换到 ${branchName}` }
  }

  // ─── commit ───────────────────────────────────────────
  async #handleCommit(args: Record<string, unknown>, cwd: string): Promise<ToolResult> {
    const files = args['files'] as string[] | undefined
    const message = args['message'] as string | undefined

    // 参数校验
    if (!files || !Array.isArray(files) || files.length === 0) {
      return { success: false, output: '', error: 'commit 需要指定 files 参数（非空数组）。' }
    }
    if (!message || !message.trim()) {
      return { success: false, output: '', error: 'commit 需要指定 message 参数。' }
    }

    // 敏感文件检测
    const sensitiveFiles = files.filter(isSensitiveFile)
    if (sensitiveFiles.length > 0) {
      return {
        success: false,
        output: '',
        error: `检测到敏感文件，已拒绝提交: ${sensitiveFiles.join(', ')}。请从文件列表中移除这些文件。`,
      }
    }

    // git add
    const addResult = await execa('git', ['add', ...files], { cwd, reject: false })
    if (addResult.exitCode !== 0) {
      return { success: false, output: '', error: addResult.stderr || '暂存文件失败。' }
    }

    // 写临时文件存放提交信息（避免命令行转义问题）
    const tmpFile = join(tmpdir(), `ccode-commit-msg-${Date.now()}.txt`)
    try {
      await writeFile(tmpFile, message, 'utf-8')
      const commitResult = await execa('git', ['commit', '-F', tmpFile], { cwd, reject: false })
      if (commitResult.exitCode !== 0) {
        return { success: false, output: '', error: commitResult.stderr || '提交失败。' }
      }
    } finally {
      // 清理临时文件
      await unlink(tmpFile).catch(() => { /* 忽略删除失败 */ })
    }

    // 获取提交 hash
    const headResult = await execa('git', ['rev-parse', 'HEAD'], { cwd, reject: false })
    const commitHash = headResult.stdout.trim()

    // 提交后状态
    const statusResult = await execa('git', ['status', '--short'], { cwd, reject: false })
    const output = [
      `提交成功: ${commitHash}`,
      '',
      '--- 提交后状态 ---',
      statusResult.stdout || '工作区干净。',
    ].join('\n')

    return { success: true, output }
  }

  // ─── merge ────────────────────────────────────────────
  async #handleMerge(args: Record<string, unknown>, cwd: string): Promise<ToolResult> {
    const abort = args['abort'] === true
    if (abort) {
      const result = await execa('git', ['merge', '--abort'], { cwd, reject: false })
      return result.exitCode === 0
        ? { success: true, output: '已中止合并操作。' }
        : { success: false, output: '', error: result.stderr || '中止合并失败。' }
    }

    const target = args['target'] as string | undefined
    if (!target) {
      return { success: false, output: '', error: 'merge 需要指定 target 参数。' }
    }

    const result = await execa('git', ['merge', target], { cwd, reject: false })
    const combined = [result.stdout, result.stderr].filter(Boolean).join('\n')

    // 检测冲突
    if (result.exitCode !== 0 && combined.includes('CONFLICT')) {
      return {
        success: false,
        output: combined,
        error: `合并 ${target} 产生冲突，请解决冲突后手动提交，或使用 abort=true 中止合并。`,
      }
    }

    if (result.exitCode !== 0) {
      return { success: false, output: combined, error: result.stderr || `合并 ${target} 失败。` }
    }

    return { success: true, output: combined || `已成功合并 ${target}。` }
  }

  // ─── rebase ───────────────────────────────────────────
  async #handleRebase(args: Record<string, unknown>, cwd: string): Promise<ToolResult> {
    const abort = args['abort'] === true
    if (abort) {
      const result = await execa('git', ['rebase', '--abort'], { cwd, reject: false })
      return result.exitCode === 0
        ? { success: true, output: '已中止变基操作。' }
        : { success: false, output: '', error: result.stderr || '中止变基失败。' }
    }

    const target = args['target'] as string | undefined
    if (!target) {
      return { success: false, output: '', error: 'rebase 需要指定 target 参数。' }
    }

    const result = await execa('git', ['rebase', target], { cwd, reject: false })
    const combined = [result.stdout, result.stderr].filter(Boolean).join('\n')

    if (result.exitCode !== 0 && combined.includes('CONFLICT')) {
      return {
        success: false,
        output: combined,
        error: `变基到 ${target} 产生冲突，请解决冲突后执行 git rebase --continue，或使用 abort=true 中止变基。`,
      }
    }

    if (result.exitCode !== 0) {
      return { success: false, output: combined, error: result.stderr || `变基到 ${target} 失败。` }
    }

    return { success: true, output: combined || `已成功变基到 ${target}。` }
  }

  // ─── cherry_pick ──────────────────────────────────────
  async #handleCherryPick(args: Record<string, unknown>, cwd: string): Promise<ToolResult> {
    const abort = args['abort'] === true
    if (abort) {
      const result = await execa('git', ['cherry-pick', '--abort'], { cwd, reject: false })
      return result.exitCode === 0
        ? { success: true, output: '已中止 cherry-pick 操作。' }
        : { success: false, output: '', error: result.stderr || '中止 cherry-pick 失败。' }
    }

    const ref = args['ref'] as string | undefined
    if (!ref) {
      return { success: false, output: '', error: 'cherry_pick 需要指定 ref 参数。' }
    }

    const result = await execa('git', ['cherry-pick', ref], { cwd, reject: false })
    const combined = [result.stdout, result.stderr].filter(Boolean).join('\n')

    if (result.exitCode !== 0 && combined.includes('CONFLICT')) {
      return {
        success: false,
        output: combined,
        error: `拣选 ${ref} 产生冲突，请解决冲突后执行 git cherry-pick --continue，或使用 abort=true 中止。`,
      }
    }

    if (result.exitCode !== 0) {
      return { success: false, output: combined, error: result.stderr || `拣选 ${ref} 失败。` }
    }

    return { success: true, output: combined || `已成功拣选 ${ref}。` }
  }

  // ─── stash ────────────────────────────────────────────
  async #handleStash(args: Record<string, unknown>, cwd: string): Promise<ToolResult> {
    const action = (args['stash_action'] as string | undefined) ?? 'push'

    const actionMap: Record<string, () => Promise<ToolResult>> = {
      push: async () => {
        const msg = args['stash_message'] as string | undefined
        const stashArgs = ['stash', 'push']
        if (msg) stashArgs.push('-m', msg)
        const result = await execa('git', stashArgs, { cwd, reject: false })
        return result.exitCode === 0
          ? { success: true, output: result.stdout || '已暂存当前变更。' }
          : { success: false, output: '', error: result.stderr || '暂存失败。' }
      },
      pop: async () => {
        const result = await execa('git', ['stash', 'pop'], { cwd, reject: false })
        return result.exitCode === 0
          ? { success: true, output: result.stdout || '已恢复最近一次暂存。' }
          : { success: false, output: '', error: result.stderr || '恢复暂存失败。' }
      },
      list: async () => {
        const result = await execa('git', ['stash', 'list'], { cwd, reject: false })
        return { success: true, output: result.stdout || '暂存列表为空。' }
      },
      drop: async () => {
        const result = await execa('git', ['stash', 'drop'], { cwd, reject: false })
        return result.exitCode === 0
          ? { success: true, output: result.stdout || '已删除最近一次暂存。' }
          : { success: false, output: '', error: result.stderr || '删除暂存失败。' }
      },
    }

    const handler = actionMap[action]
    if (!handler) {
      return { success: false, output: '', error: `未知 stash 操作: ${action}` }
    }

    return handler()
  }

  // ─── tag ──────────────────────────────────────────────
  async #handleTag(args: Record<string, unknown>, cwd: string): Promise<ToolResult> {
    const tagName = args['tag_name'] as string | undefined
    const tagDelete = args['tag_delete'] === true
    const message = args['message'] as string | undefined

    // 无 tag_name → 列出标签
    if (!tagName) {
      const result = await execa(
        'git', ['tag', '-l', '--sort=-creatordate', '--format=%(refname:short) %(creatordate:short)'],
        { cwd, reject: false },
      )
      return { success: true, output: result.stdout || '暂无标签。' }
    }

    // 删除标签
    if (tagDelete) {
      const result = await execa('git', ['tag', '-d', tagName], { cwd, reject: false })
      return result.exitCode === 0
        ? { success: true, output: result.stdout || `已删除标签 ${tagName}。` }
        : { success: false, output: '', error: result.stderr || `删除标签 ${tagName} 失败。` }
    }

    // 创建标签
    const tagArgs = message
      ? ['tag', '-a', tagName, '-m', message]
      : ['tag', tagName]
    const result = await execa('git', tagArgs, { cwd, reject: false })
    return result.exitCode === 0
      ? { success: true, output: result.stdout || `已创建标签 ${tagName}。` }
      : { success: false, output: '', error: result.stderr || `创建标签 ${tagName} 失败。` }
  }

  // ─── reset ────────────────────────────────────────────
  async #handleReset(args: Record<string, unknown>, cwd: string): Promise<ToolResult> {
    const ref = args['ref'] as string | undefined
    if (!ref) {
      return { success: false, output: '', error: 'reset 需要指定 ref 参数。' }
    }

    const mode = (args['mode'] as string | undefined) ?? 'mixed'
    const validModes = ['soft', 'mixed', 'hard']
    if (!validModes.includes(mode)) {
      return { success: false, output: '', error: `无效的 reset 模式: ${mode}，可选值: soft, mixed, hard` }
    }

    const result = await execa('git', ['reset', `--${mode}`, ref], { cwd, reject: false })
    if (result.exitCode !== 0) {
      return { success: false, output: '', error: result.stderr || `重置到 ${ref} 失败。` }
    }

    return { success: true, output: result.stdout || `已重置到 ${ref}（模式: ${mode}）。` }
  }
}
