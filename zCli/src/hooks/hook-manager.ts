// src/hooks/hook-manager.ts

import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { HookRunner } from './hook-runner.js'
import type {
  HookEventType,
  HooksConfig,
  ResolvedHookEntry,
  HookContext,
} from './types.js'

/**
 * HookManager — 发现、合并、调度
 * 负责从 hooks.json 文件中加载 hook 定义，合并多层来源，按事件类型和 matcher 分发执行。
 */
export class HookManager {
  #entries: ResolvedHookEntry[] = []
  readonly #runner: HookRunner

  constructor(runner?: HookRunner) {
    this.#runner = runner ?? new HookRunner()
  }

  /** 从一个 hooks.json 文件加载 hook 定义 */
  async discoverFromFile(
    filePath: string,
    source: ResolvedHookEntry['source'],
    pluginName?: string,
  ): Promise<void> {
    try {
      const raw = await readFile(filePath, 'utf-8')
      const config: HooksConfig = JSON.parse(raw)
      const cwd = dirname(filePath)

      for (const [eventStr, rules] of Object.entries(config.hooks)) {
        const event = eventStr as HookEventType
        if (!rules) continue
        for (const rule of rules) {
          const matcher = new RegExp(rule.matcher)
          for (const action of rule.hooks) {
            const entry: ResolvedHookEntry = { source, event, matcher, action, cwd }
            if (pluginName) entry.pluginName = pluginName
            this.#entries.push(entry)
          }
        }
      }
    } catch {
      // 文件不存在或 JSON 解析失败，静默跳过
    }
  }

  /** 获取指定事件的全部 hook */
  getHooks(event: HookEventType): ResolvedHookEntry[] {
    return this.#entries.filter((e) => e.event === event)
  }

  /** 获取指定事件中匹配 trigger 的 hook */
  getMatchedHooks(event: HookEventType, trigger: string): ResolvedHookEntry[] {
    return this.#entries.filter((e) => e.event === event && e.matcher.test(trigger))
  }

  /** 执行指定事件的所有匹配 hook，返回结果列表 */
  async run(
    event: HookEventType,
    ctx: HookContext,
  ): Promise<Array<Record<string, unknown> | null>> {
    const matched = this.getMatchedHooks(event, ctx.trigger)
    const results: Array<Record<string, unknown> | null> = []

    for (const entry of matched) {
      const env: Record<string, string> = { ...ctx.env }
      if (entry.pluginName) {
        // cwd 即 hooks.json 所在目录，就是插件根目录
        env['CCODE_PLUGIN_ROOT'] = entry.cwd
      }
      const runOpts: import('./hook-runner.js').RunOptions = {
        command: entry.action.command,
        cwd: entry.cwd,
        env,
        timeout: entry.action.timeout ?? 10000,
      }
      if (ctx.stdin) runOpts.stdin = ctx.stdin
      const result = await this.#runner.run(runOpts)
      results.push(result)
    }

    return results
  }
}
