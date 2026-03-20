// src/ui/terminal-screen.ts

/**
 * 终端屏幕管理。
 *
 * 进入对话模式时彻底清屏（可见区域 + scrollback），
 * 确保 Ink 在干净画布上渲染。
 *
 * 不使用备用屏幕缓冲区（\x1b[?1049h）：
 * 备用屏幕不支持 scrollback，Ink 输出的聊天历史无法上滚查看。
 * vim/less 可以用是因为它们自己管理滚动，但 Ink 依赖终端原生 scrollback。
 */

/** 是否已执行过首次清屏 */
let hasCleared = false

/**
 * 清屏进入对话模式：清除可见区域 + 光标归位。
 * 幂等：多次调用只生效一次（首次进入对话时清除 WelcomeScreen 残留）。
 *
 * 注意：不清除 scrollback 缓冲区（\x1b[3J），保留终端滚动历史。
 * 用户可以向上滚动查看之前的输出。
 */
export function enterAlternateScreen(): void {
  if (hasCleared) return
  hasCleared = true
  // \x1b[2J — 清除可见区域（WelcomeScreen 消失）
  // \x1b[H  — 光标归位到左上角
  process.stdout.write('\x1b[2J\x1b[H')
}

/**
 * 退出时的清理操作。
 * 当前实现无需特殊处理（不再使用备用屏幕），保留接口兼容性。
 */
export function leaveAlternateScreen(): void {
  // 不使用备用屏幕，无需还原
}
