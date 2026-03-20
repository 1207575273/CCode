// src/server/dashboard/plugins-api.ts

/**
 * 插件与 Skill 管理 API
 *
 * GET  /api/plugins                  — 已安装插件列表
 * GET  /api/plugins/claude-available — 从 Claude Code 可导入的插件
 * POST /api/plugins/import-claude    — 从 Claude Code 导入（复制目录）
 * POST /api/plugins/delete           — 删除插件
 * POST /api/plugins/install-skill    — 从 skills.sh 安装 skill（npx skills add）
 */

import { Hono } from 'hono'
import { existsSync, readFileSync, mkdirSync, rmSync, cpSync, readdirSync, writeFileSync, renameSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import fg from 'fast-glob'

/** ZCli 插件根目录 */
const ccodePluginsDir = () => join(homedir(), '.ccode', 'plugins')
/** Claude Code 插件注册表 */
const claudeInstalledPath = () => join(homedir(), '.claude', 'plugins', 'installed_plugins.json')

interface PluginInfo {
  name: string
  installPath: string
  source: 'ccode' | 'claude-code' | 'manual'
  version: string
  skillCount: number
  hasHooks: boolean
  description?: string
}

interface ClaudeAvailablePlugin {
  name: string
  marketplace: string
  version: string
  installPath: string
  alreadyImported: boolean
}

export function createPluginsRoutes(): Hono {
  const api = new Hono()

  // ═══ 已安装插件列表 ═══
  api.get('/', (c) => {
    try {
      const plugins = scanInstalledPlugins()
      return c.json({ plugins })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  // ═══ Claude Code 可导入的插件 ═══
  api.get('/claude-available', (c) => {
    try {
      const available = scanClaudePlugins()
      return c.json({ available })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  // ═══ 从 Claude Code 导入 ═══
  api.post('/import-claude', async (c) => {
    try {
      const body = await c.req.json() as { name: string; sourcePath: string }
      const targetDir = join(ccodePluginsDir(), body.name)

      if (existsSync(targetDir)) {
        return c.json({ error: `插件 ${body.name} 已存在` }, 400)
      }

      if (!existsSync(body.sourcePath)) {
        return c.json({ error: `源路径不存在: ${body.sourcePath}` }, 400)
      }

      mkdirSync(ccodePluginsDir(), { recursive: true })
      cpSync(body.sourcePath, targetDir, { recursive: true })

      return c.json({ success: true, installPath: targetDir })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  // ═══ 删除插件 ═══
  api.post('/delete', async (c) => {
    try {
      const body = await c.req.json() as { name: string }
      const targetDir = join(ccodePluginsDir(), body.name)

      if (!existsSync(targetDir)) {
        return c.json({ error: `插件 ${body.name} 不存在` }, 400)
      }

      rmSync(targetDir, { recursive: true, force: true })
      return c.json({ success: true })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  // ═══ 从 skills.sh 安装 skill ═══
  api.post('/install-skill', async (c) => {
    try {
      const body = await c.req.json() as { source: string; skill?: string }
      const source = body.source?.trim()
      if (!source) {
        return c.json({ error: 'source 不能为空' }, 400)
      }

      // npx skills add 安装到 cwd/.claude/skills/ 下
      // 用临时目录执行，然后把 skill 搬到 ~/.ccode/plugins/ 下
      const { mkdtempSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const tempDir = mkdtempSync(join(tmpdir(), 'ccode-skill-'))

      const args = ['skills', 'add', source, '--yes', '--copy']
      if (body.skill) {
        args.push('--skill', body.skill)
      }

      const { execa } = await import('execa')
      const result = await execa('npx', args, {
        cwd: tempDir,
        timeout: 120_000,
        reject: false,
        env: { ...process.env, HOME: homedir(), USERPROFILE: homedir() },
      })

      // npx skills 即使找不到 skill 也可能 exitCode=0，检查输出
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
      if (output.includes('No matching skills found')) {
        // 清理临时目录
        rmSync(tempDir, { recursive: true, force: true })
        return c.json({ error: `未找到匹配的 skill。输出:\n${output}` }, 400)
      }

      // 扫描临时目录下安装的 skills（.claude/skills/<name>/SKILL.md）
      const claudeSkillsDir = join(tempDir, '.claude', 'skills')
      let installed: string[] = []
      if (existsSync(claudeSkillsDir)) {
        installed = readdirSync(claudeSkillsDir, { withFileTypes: true })
          .filter(d => d.isDirectory() && existsSync(join(claudeSkillsDir, d.name, 'SKILL.md')))
          .map(d => d.name)
      }

      if (installed.length === 0) {
        rmSync(tempDir, { recursive: true, force: true })
        return c.json({ error: `安装完成但未找到 SKILL.md。输出:\n${output}` }, 400)
      }

      // 搬到 ~/.ccode/plugins/<repoName>/skills/<skillName>/
      const repoName = source.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\//g, '--')
      const targetPluginDir = join(ccodePluginsDir(), repoName)
      const targetSkillsDir = join(targetPluginDir, 'skills')
      mkdirSync(targetSkillsDir, { recursive: true })

      for (const skillName of installed) {
        const src = join(claudeSkillsDir, skillName)
        const dst = join(targetSkillsDir, skillName)
        if (existsSync(dst)) {
          rmSync(dst, { recursive: true, force: true })
        }
        // 跨盘移动可能失败（Windows 临时目录和用户目录可能不在同一盘），
        // 先尝试 rename（同盘零拷贝），失败回退到 cp + rm
        try {
          renameSync(src, dst)
        } catch {
          cpSync(src, dst, { recursive: true })
        }
      }

      // 写一个 plugin.json 元数据
      const pluginJsonPath = join(targetPluginDir, 'plugin.json')
      if (!existsSync(pluginJsonPath)) {
        writeFileSync(pluginJsonPath, JSON.stringify({
          name: repoName,
          description: `Skills from ${source}`,
          version: '1.0.0',
          source,
          installedAt: new Date().toISOString(),
        }, null, 2), 'utf-8')
      }

      // 清理临时目录
      rmSync(tempDir, { recursive: true, force: true })

      return c.json({
        success: true,
        installed: installed,
        pluginName: repoName,
        message: `成功安装 ${installed.length} 个 skill: ${installed.join(', ')}`,
      })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  return api
}

/** 扫描已安装的 ZCli 插件 */
function scanInstalledPlugins(): PluginInfo[] {
  const dir = ccodePluginsDir()
  if (!existsSync(dir)) return []

  const plugins: PluginInfo[] = []
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const pluginDir = join(dir, entry.name)
      const info = analyzePlugin(entry.name, pluginDir)
      if (info) plugins.push(info)
    }
  } catch { /* 目录不存在或无权限 */ }

  return plugins
}

/** 分析单个插件目录 */
function analyzePlugin(name: string, pluginDir: string): PluginInfo | null {
  // 统计 skills 数量
  const skillsDir = join(pluginDir, 'skills')
  let skillCount = 0
  try {
    const pattern = skillsDir.replace(/\\/g, '/') + '/*/SKILL.md'
    // 同步用 readdirSync 简单统计
    if (existsSync(skillsDir)) {
      const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
      skillCount = skillDirs.filter(d => d.isDirectory() && existsSync(join(skillsDir, d.name, 'SKILL.md'))).length
    }
  } catch { /* ignore */ }

  // 检查 hooks
  const hasHooks = existsSync(join(pluginDir, 'hooks', 'hooks.json'))

  // 读取 plugin.json（如果有）
  let description = ''
  let version = 'unknown'
  try {
    // Claude Code 格式
    const claudePlugin = join(pluginDir, '.claude-plugin', 'plugin.json')
    // ZCli 格式
    const ccodePlugin = join(pluginDir, 'plugin.json')
    const metaPath = existsSync(claudePlugin) ? claudePlugin : existsSync(ccodePlugin) ? ccodePlugin : null
    if (metaPath) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
      description = meta.description ?? ''
      version = meta.version ?? 'unknown'
    }
  } catch { /* ignore */ }

  return {
    name,
    installPath: pluginDir,
    source: 'ccode',
    version,
    skillCount,
    hasHooks,
    description,
  }
}

/** 扫描 Claude Code 已安装的插件，标记哪些已导入到 ZCli */
function scanClaudePlugins(): ClaudeAvailablePlugin[] {
  const installedPath = claudeInstalledPath()
  if (!existsSync(installedPath)) return []

  try {
    const data = JSON.parse(readFileSync(installedPath, 'utf-8'))
    const plugins: ClaudeAvailablePlugin[] = []
    const existingNames = new Set(scanInstalledPlugins().map(p => p.name))

    for (const [key, entries] of Object.entries(data.plugins ?? {})) {
      // key 格式: "superpowers@claude-plugins-official"
      const [name, marketplace] = key.split('@')
      if (!name || !Array.isArray(entries) || entries.length === 0) continue

      // 取最新的一条（最后安装/更新的）
      const latest = entries[entries.length - 1] as { installPath: string; version: string }
      if (!latest.installPath || !existsSync(latest.installPath)) continue

      plugins.push({
        name,
        marketplace: marketplace ?? 'unknown',
        version: latest.version ?? 'unknown',
        installPath: latest.installPath,
        alreadyImported: existingNames.has(name),
      })
    }

    return plugins
  } catch {
    return []
  }
}
