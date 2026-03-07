// src/commands/model.ts

/**
 * /model 指令 — 切换 AI 模型，支持三种子命令。
 *
 * /model         → 打开交互式 ModelPicker 弹窗
 * /model info    → 以 system 消息展示当前模型信息
 * /model <name>  → 直接切换到指定模型（provider 由 App.tsx 从 config 解析）
 *
 * 该类在构造时接收当前 provider/model，App.tsx 通过 useMemo([currentProvider, currentModel])
 * 在模型切换后重建实例，确保 /model info 始终反映最新状态。
 */

import type { Command, CommandResult } from '@commands/types.js'

export class ModelCommand implements Command {
  readonly name = 'model'
  readonly aliases = ['m'] as const
  readonly description = 'Switch AI model (/model <name> | /model info)'

  /**
   * @param currentProvider 当前激活的 provider 名称（如 "anthropic"、"glm"）
   * @param currentModel    当前激活的模型名称（如 "claude-sonnet-4-6"）
   */
  constructor(
    private readonly currentProvider: string,
    private readonly currentModel: string,
  ) {}

  execute(args: string[]): CommandResult {
    // 无参数 → 打开交互式选择弹窗
    if (args.length === 0) {
      return { handled: true, action: { type: 'show_model_picker' } }
    }

    // /model info → 展示当前模型信息卡片
    if (args[0] === 'info') {
      const content = `Current model: ${this.currentModel} (${this.currentProvider})`
      return { handled: true, action: { type: 'show_help', content } }
    }

    // /model <name> → 直接切换；provider 留空，由 App.tsx 持有完整 config 后解析匹配。
    // 使用 ?? '' 满足 noUncheckedIndexedAccess：length 检查已保证 args[0] 存在，
    // 但 TypeScript 无法收窄数组元素类型。
    const modelName = args[0] ?? ''
    if (!modelName) {
      // 空字符串（如 execute(['']) 被直接调用）同样回退到选择弹窗
      return { handled: true, action: { type: 'show_model_picker' } }
    }
    return {
      handled: true,
      action: { type: 'switch_model', provider: '', model: modelName },
    }
  }
}
