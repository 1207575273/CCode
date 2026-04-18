// cCli/tests/unit/dispatch-agent-stop-guidance.test.ts

/**
 * 单元测试：buildStopGuidance — 子 Agent 停止时给主 Agent 的行为指引
 *
 * 背景：
 * 用户在 Web/CLI 主动停止子 Agent 时，主 Agent 会把子 Agent 的 StopReport 作为
 * dispatch_agent 工具结果处理。实测 LLM 容易把 user 主动停止误解为"执行失败"
 * 而自己代替完成任务，违背用户意图。buildStopGuidance 负责生成自然语言
 * 行为指引（guidance 字段），引导主 Agent 停下来询问用户。
 *
 * 测试策略：
 * 不锁死完整文案（文案可能微调），但锁死**核心语义承诺**——
 * 即使以后改文案，"禁止代替执行"、"必须询问用户"这类关键规则不能丢。
 */

import { describe, it, expect } from 'vitest'
import { buildStopGuidance } from '@tools/agent/dispatch-agent.js'
import type { StopSource } from '@tools/agent/store.js'

describe('buildStopGuidance', () => {
  // ═══════════════════════════════════════════════
  // 用户主动停止（user_web / user_cli）— 最关键场景
  // ═══════════════════════════════════════════════

  describe('source=user_web（Web 端主动停止）', () => {
    const graceful = buildStopGuidance('user_web', 'graceful')
    const forced = buildStopGuidance('user_web', 'forced')

    it('应标注 Web 端来源', () => {
      expect(graceful).toContain('Web 端')
    })

    it('应在 graceful / forced 下都返回引导内容', () => {
      expect(graceful.length).toBeGreaterThan(100)
      expect(forced.length).toBeGreaterThan(100)
    })

    it('必须明确禁止主 Agent 代替执行', () => {
      // 核心承诺 — 文案可调，但"禁止代替执行"的语义不能丢
      expect(graceful).toMatch(/禁止/)
      expect(graceful).toMatch(/代替|代为|自己.*执行/)
    })

    it('必须明确禁止主 Agent 重新派发同任务', () => {
      expect(graceful).toMatch(/重新派发|重派|派发同|再派|相同或相似/)
    })

    it('必须要求主 Agent 询问用户', () => {
      expect(graceful).toMatch(/询问用户|询问.*?接下来|问用户/)
    })

    it('必须提供三种用户选项引导（放弃/换方式/其他）', () => {
      expect(graceful).toMatch(/放弃/)
      expect(graceful).toMatch(/换|换一种|换种/)
      expect(graceful).toMatch(/其他|别的|其它/)
    })

    it('必须告知主 Agent 在用户回复前不要调用工具', () => {
      // 防止 LLM 只"嘴上答应"然后偷偷继续调用工具
      expect(graceful).toMatch(/不要.*(?:操作|调用|工具)|等待.*指示/)
    })

    it('应体现 resolution 信息（便于主 Agent 汇报给用户）', () => {
      expect(graceful).toContain('graceful')
      expect(forced).toContain('forced')
    })
  })

  describe('source=user_cli（CLI 端主动停止）', () => {
    const guidance = buildStopGuidance('user_cli', 'graceful')

    it('应标注 CLI 端来源', () => {
      expect(guidance).toContain('CLI 端')
      expect(guidance).not.toContain('Web 端')
    })

    it('应与 user_web 共享相同的核心承诺（禁止代替 / 必须询问）', () => {
      // user_cli 和 user_web 只是触发渠道不同，用户意图一致，引导策略必须一致
      expect(guidance).toMatch(/禁止/)
      expect(guidance).toMatch(/询问/)
    })
  })

  // ═══════════════════════════════════════════════
  // 非用户主动停止 — 不应触发询问流程
  // ═══════════════════════════════════════════════

  describe('source=timeout（超时停止）', () => {
    const graceful = buildStopGuidance('timeout', 'graceful')
    const forced = buildStopGuidance('timeout', 'forced')

    it('应提示"超时"且引导根据 partialResult 决策', () => {
      expect(graceful).toContain('超时')
      expect(graceful).toContain('partialResult')
    })

    it('graceful 与 forced 文案应有区分（resolution 可读）', () => {
      expect(forced).toMatch(/强制/)
      expect(graceful).toMatch(/优雅/)
    })

    it('不应阻止主 Agent 继续推进任务（语义不同于 user 主动停止）', () => {
      // timeout 情况下主 Agent 可以继续决策，不应出现"禁止代替执行"这类硬约束
      expect(graceful).not.toMatch(/禁止.*代替/)
    })
  })

  describe('source=parent_agent（主 Agent 自己停了子 Agent）', () => {
    const guidance = buildStopGuidance('parent_agent', 'graceful')

    it('应提示主 Agent 继续主流程', () => {
      expect(guidance).toMatch(/继续.*主流程|主流程.*继续|继续你的/)
    })

    it('不应要求询问用户（这是主 Agent 自己的决策结果）', () => {
      expect(guidance).not.toMatch(/询问用户/)
    })
  })

  // ═══════════════════════════════════════════════
  // 未知来源 — 兜底
  // ═══════════════════════════════════════════════

  describe('兜底：未知 source', () => {
    it('应返回非空引导（不 throw，不返回空串）', () => {
      // 未来若新增 StopSource 值，buildStopGuidance 必须有兜底，
      // 避免主 Agent 收到空 guidance 而不知所措
      const unknownSource = 'future_new_source' as unknown as StopSource
      const guidance = buildStopGuidance(unknownSource, 'graceful')
      expect(guidance.length).toBeGreaterThan(0)
      expect(guidance).toContain('future_new_source')
    })
  })

  // ═══════════════════════════════════════════════
  // 跨场景不变量
  // ═══════════════════════════════════════════════

  describe('所有场景的公共约束', () => {
    const allSources: StopSource[] = ['user_web', 'user_cli', 'timeout', 'parent_agent']
    const allResolutions: Array<'graceful' | 'forced'> = ['graceful', 'forced']

    it('任意 source × resolution 组合必须返回非空字符串', () => {
      for (const source of allSources) {
        for (const resolution of allResolutions) {
          const g = buildStopGuidance(source, resolution)
          expect(g, `${source}/${resolution} 返回空`).toBeTruthy()
          expect(typeof g).toBe('string')
        }
      }
    })

    it('user_web 与 user_cli 的引导结构应一致（只有 channel 措辞不同）', () => {
      // 确保两个 user-initiated 场景行为一致，不会因漏改一边而出现不一致引导
      const web = buildStopGuidance('user_web', 'graceful')
      const cli = buildStopGuidance('user_cli', 'graceful')
      // 替换渠道词后应该完全一致
      expect(web.replace(/Web 端/g, 'X')).toBe(cli.replace(/CLI 端/g, 'X'))
    })
  })
})
