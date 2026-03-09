import { describe, it, expectTypeOf } from 'vitest'
import type {
  SessionEventType,
  SessionEvent,
  SessionSnapshot,
  SessionSummary,
} from '@persistence/session-types.js'
import type { TokenUsage, MessageContent } from '@core/types.js'

describe('SessionEventType', () => {
  it('should accept valid event type literals', () => {
    expectTypeOf<'session_start'>().toMatchTypeOf<SessionEventType>()
    expectTypeOf<'session_resume'>().toMatchTypeOf<SessionEventType>()
    expectTypeOf<'user'>().toMatchTypeOf<SessionEventType>()
    expectTypeOf<'assistant'>().toMatchTypeOf<SessionEventType>()
    expectTypeOf<'system'>().toMatchTypeOf<SessionEventType>()
    expectTypeOf<'tool_call'>().toMatchTypeOf<SessionEventType>()
    expectTypeOf<'tool_result'>().toMatchTypeOf<SessionEventType>()
    expectTypeOf<'turn_duration'>().toMatchTypeOf<SessionEventType>()
  })

  it('should reject invalid event type literals', () => {
    expectTypeOf<'invalid_type'>().not.toMatchTypeOf<SessionEventType>()
  })
})

describe('SessionEvent', () => {
  it('should have required fields with correct types', () => {
    expectTypeOf<SessionEvent>().toHaveProperty('sessionId').toBeString()
    expectTypeOf<SessionEvent>().toHaveProperty('type').toMatchTypeOf<SessionEventType>()
    expectTypeOf<SessionEvent>().toHaveProperty('timestamp').toBeString()
    expectTypeOf<SessionEvent>().toHaveProperty('uuid').toBeString()
    expectTypeOf<SessionEvent>().toHaveProperty('parentUuid').toMatchTypeOf<string | null>()
    expectTypeOf<SessionEvent>().toHaveProperty('cwd').toBeString()
  })

  it('should have optional message field with correct shape', () => {
    type MessageField = NonNullable<SessionEvent['message']>
    expectTypeOf<MessageField>().toHaveProperty('role').toBeString()
    expectTypeOf<MessageField>().toHaveProperty('content').toMatchTypeOf<string | MessageContent[]>()
    expectTypeOf<MessageField['model']>().toMatchTypeOf<string | undefined>()
    expectTypeOf<MessageField['usage']>().toMatchTypeOf<TokenUsage | undefined>()
  })

  it('should have optional tool-related fields', () => {
    expectTypeOf<SessionEvent['toolCallId']>().toMatchTypeOf<string | undefined>()
    expectTypeOf<SessionEvent['toolName']>().toMatchTypeOf<string | undefined>()
    expectTypeOf<SessionEvent['args']>().toMatchTypeOf<Record<string, unknown> | undefined>()
    expectTypeOf<SessionEvent['result']>().toMatchTypeOf<string | undefined>()
    expectTypeOf<SessionEvent['isError']>().toMatchTypeOf<boolean | undefined>()
  })

  it('should have optional metadata fields', () => {
    expectTypeOf<SessionEvent['gitBranch']>().toMatchTypeOf<string | undefined>()
    expectTypeOf<SessionEvent['provider']>().toMatchTypeOf<string | undefined>()
    expectTypeOf<SessionEvent['model']>().toMatchTypeOf<string | undefined>()
    expectTypeOf<SessionEvent['error']>().toMatchTypeOf<string | undefined>()
    expectTypeOf<SessionEvent['durationMs']>().toMatchTypeOf<number | undefined>()
  })
})

describe('SessionSnapshot', () => {
  it('should have all required fields with correct types', () => {
    expectTypeOf<SessionSnapshot>().toHaveProperty('sessionId').toBeString()
    expectTypeOf<SessionSnapshot>().toHaveProperty('provider').toBeString()
    expectTypeOf<SessionSnapshot>().toHaveProperty('model').toBeString()
    expectTypeOf<SessionSnapshot>().toHaveProperty('cwd').toBeString()
  })

  it('should have messages array with correct element shape', () => {
    type Msg = SessionSnapshot['messages'][number]
    expectTypeOf<Msg>().toHaveProperty('id').toBeString()
    expectTypeOf<Msg>().toHaveProperty('role').toMatchTypeOf<'user' | 'assistant'>()
    expectTypeOf<Msg>().toHaveProperty('content').toBeString()
  })
})

describe('SessionSummary', () => {
  it('should have all required fields with correct types', () => {
    expectTypeOf<SessionSummary>().toHaveProperty('sessionId').toBeString()
    expectTypeOf<SessionSummary>().toHaveProperty('projectSlug').toBeString()
    expectTypeOf<SessionSummary>().toHaveProperty('firstMessage').toBeString()
    expectTypeOf<SessionSummary>().toHaveProperty('updatedAt').toBeString()
    expectTypeOf<SessionSummary>().toHaveProperty('gitBranch').toBeString()
    expectTypeOf<SessionSummary>().toHaveProperty('fileSize').toBeNumber()
    expectTypeOf<SessionSummary>().toHaveProperty('filePath').toBeString()
  })
})
