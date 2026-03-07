// tests/unit/commands-model.test.ts
import { describe, it, expect } from 'vitest'
import { ModelCommand } from '@commands/model.js'

describe('ModelCommand', () => {
  const PROVIDER = 'anthropic'
  const MODEL = 'claude-sonnet-4-6'

  function makeCmd() {
    return new ModelCommand(PROVIDER, MODEL)
  }

  // --- 基本属性 ---

  it('name should be "model"', () => {
    expect(makeCmd().name).toBe('model')
  })

  it('aliases should contain "m"', () => {
    expect(makeCmd().aliases).toContain('m')
  })

  it('description should be non-empty', () => {
    expect(makeCmd().description.length).toBeGreaterThan(0)
  })

  // --- /model（无参数）→ show_model_picker ---

  it('should return show_model_picker when no args given', () => {
    const result = makeCmd().execute([])
    expect(result.handled).toBe(true)
    expect(result.action?.type).toBe('show_model_picker')
  })

  // --- /model info → show_help with current model info ---

  it('should return show_help when args is ["info"]', () => {
    const result = makeCmd().execute(['info'])
    expect(result.handled).toBe(true)
    expect(result.action?.type).toBe('show_help')
  })

  it('should include currentModel in info content', () => {
    const result = makeCmd().execute(['info'])
    if (result.action?.type !== 'show_help') throw new Error('Expected show_help')
    expect(result.action.content).toContain(MODEL)
  })

  it('should include currentProvider in info content', () => {
    const result = makeCmd().execute(['info'])
    if (result.action?.type !== 'show_help') throw new Error('Expected show_help')
    expect(result.action.content).toContain(PROVIDER)
  })

  // --- /model <name> → switch_model ---

  it('should return switch_model when a model name is given', () => {
    const result = makeCmd().execute(['glm-5'])
    expect(result.handled).toBe(true)
    expect(result.action?.type).toBe('switch_model')
  })

  it('should carry the given model name in switch_model action', () => {
    const result = makeCmd().execute(['glm-5'])
    if (result.action?.type !== 'switch_model') throw new Error('Expected switch_model')
    expect(result.action.model).toBe('glm-5')
  })

  it('should leave provider as empty string for App.tsx to resolve', () => {
    const result = makeCmd().execute(['glm-5'])
    if (result.action?.type !== 'switch_model') throw new Error('Expected switch_model')
    expect(result.action.provider).toBe('')
  })

  // --- handled === true in all cases ---

  it('handled should be true for no-args case', () => {
    expect(makeCmd().execute([]).handled).toBe(true)
  })

  it('handled should be true for info case', () => {
    expect(makeCmd().execute(['info']).handled).toBe(true)
  })

  it('handled should be true for direct-switch case', () => {
    expect(makeCmd().execute(['some-model']).handled).toBe(true)
  })

  // --- 边界：extra args after "info" are ignored ---

  it('should still return show_help when args starts with "info" even with extra tokens', () => {
    const result = makeCmd().execute(['info', 'extra'])
    expect(result.action?.type).toBe('show_help')
  })
})
