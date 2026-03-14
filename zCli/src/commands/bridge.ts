// src/commands/bridge.ts

import type { Command, CommandResult } from './types.js'

/**
 * /bridge 指令 — 管理 Bridge Server（CLI ↔ Web 桥接服务）
 *
 * 用法：
 *   /bridge status   查看 Bridge Server 状态
 *   /bridge stop     关闭 Bridge Server（所有 Web 客户端断开）
 */
export class BridgeCommand implements Command {
  readonly name = 'bridge'
  readonly description = '管理 Bridge Server（Web UI 桥接服务）'

  execute(args: string[]): CommandResult {
    const sub = args[0] ?? 'status'
    switch (sub) {
      case 'status':
        return { handled: true, action: { type: 'bridge_status' } }
      case 'stop':
        return { handled: true, action: { type: 'bridge_stop' } }
      default:
        return { handled: true, action: { type: 'error', message: `未知子命令: ${sub}。用法: /bridge status | stop` } }
    }
  }
}
