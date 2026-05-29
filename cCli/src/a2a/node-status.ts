// src/a2a/node-status.ts

/**
 * 本会话 A2A 节点的运行时状态（进程内全局单例）。
 *
 * ccli 启动本地 A2A 节点后写入；StatusBar(CLI + Web) 读取以展示
 * "当前会话可被 A2A 连接"标记。进程退出时内存态自然消失，无需手动清理。
 */

export interface LocalA2ANodeStatus {
  /** A2A 节点监听端口 */
  port: number
  /** 完整 baseUrl（含局域网 IP），可直接给其他机器/会话连接 */
  baseUrl: string
  /** 项目名（展示用） */
  projectName: string
}

let current: LocalA2ANodeStatus | null = null

/** 标记本会话已成为可被连接的 A2A 节点 */
export function setLocalA2ANode(status: LocalA2ANodeStatus): void {
  current = status
}

/** 取消标记（节点停止时） */
export function clearLocalA2ANode(): void {
  current = null
}

/** 读取当前 A2A 节点状态；null 表示本会话不是 A2A 节点 */
export function getLocalA2ANode(): LocalA2ANodeStatus | null {
  return current
}
