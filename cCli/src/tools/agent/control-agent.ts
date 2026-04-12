// src/tools/agent/control-agent.ts

/**
 * ControlAgentTool — 主 Agent 编程式停止后台子 Agent。
 *
 * 底层调用 store.stopAgent()，走"优雅退出 + 宽限期强制"统一路径。
 *
 * 约束：
 * - 仅对后台 SubAgent 有效（前台 SubAgent 阻塞主 AgentLoop，无法同时调用工具）
 * - 子 Agent 工具列表中始终排除（ALWAYS_EXCLUDE），防止嵌套停止
 */

import { stopAgent } from './store.js'
import type { Tool, ToolContext, ToolResult } from '../core/types.js'

export class ControlAgentTool implements Tool {
  readonly name = 'control_agent'
  readonly dangerous = false
  readonly description = [
    '停止正在后台运行的子 Agent（run_in_background=true 派发的）。',
    '子 Agent 会先尝试优雅退出（完成当前轮），超时后强制中断。',
    '停止后可用 task_output 查询最终报告（含部分结果和执行进度）。',
    '',
    '注意：此工具只对后台 SubAgent 有效。前台 SubAgent 由用户通过 CLI/Web 面板停止。',
  ].join('\n')
  readonly parameters = {
    type: 'object' as const,
    properties: {
      agent_id: {
        type: 'string' as const,
        description: 'agent ID 或 name（从 dispatch_agent 返回的 agentId，或自定义的 name）',
      },
      reason: {
        type: 'string' as const,
        description: '停止原因（将包含在汇报中，帮助后续决策）',
      },
    },
    required: ['agent_id', 'reason'] as const,
  }

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const id = String(args['agent_id'] ?? '')
    const reason = String(args['reason'] ?? '主 Agent 请求停止')

    if (!id) {
      return { success: false, output: '', error: 'agent_id 不能为空' }
    }

    const result = stopAgent(id, 'parent_agent', reason)
    if (!result.success) {
      return { success: false, output: '', error: result.error ?? 'stop failed' }
    }

    return {
      success: true,
      output: [
        `已向后台子 Agent "${id}" 发起停止请求（原因: ${reason}）`,
        '子 Agent 将在当前轮结束后退出。',
        '用 task_output(agent_id=..., block=true) 查询最终报告。',
      ].join('\n'),
    }
  }
}
