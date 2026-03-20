// tests/unit/session-store.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionStore } from '@persistence/session-store'
import type { SessionEvent } from '@persistence/session-types'
import { toProjectSlug, generateEventId } from '@persistence/session-utils'

let tempDir: string
let store: SessionStore

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'session-store-test-'))
  store = new SessionStore(tempDir)
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('SessionStore.create', () => {
  it('should_create_session_and_write_session_start_event', () => {
    const cwd = '/tmp/test-project'
    const sessionId = store.create(cwd, 'anthropic', 'claude-opus-4-20250514')

    expect(sessionId).toBeTruthy()
    expect(typeof sessionId).toBe('string')

    // Verify the JSONL file contains a session_start event
    const snapshot = store.loadMessages(sessionId)
    expect(snapshot.sessionId).toBe(sessionId)
    expect(snapshot.provider).toBe('anthropic')
    expect(snapshot.model).toBe('claude-opus-4-20250514')
    expect(snapshot.cwd).toBe(cwd)
    expect(snapshot.messages).toEqual([])
  })

  it('should_create_jsonl_in_correct_project_subdirectory', () => {
    const cwd = '/home/user/my-project'
    const sessionId = store.create(cwd, 'openai', 'gpt-4')

    const projectSlug = toProjectSlug(cwd)
    const projectDir = join(tempDir, projectSlug)

    // The project directory should contain exactly one JSONL file
    // readdirSync 已在顶部 import
    const files = readdirSync(projectDir) as string[]
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^\d{17}_.+\.jsonl$/)
    expect(files[0]).toContain(sessionId)
  })
})

describe('SessionStore.append + loadMessages', () => {
  it('should_round_trip_user_and_assistant_messages', () => {
    const cwd = '/tmp/test-project'
    const sessionId = store.create(cwd, 'anthropic', 'claude-opus-4-20250514')

    // Read session_start uuid to form a proper parent chain
    const filePath = store.list()[0]!.filePath
    const startEvent = JSON.parse(
      readFileSync(filePath, 'utf-8').trim().split('\n')[0]!,
    ) as SessionEvent
    const startUuid = startEvent.uuid

    const userEvent: SessionEvent = {
      sessionId,
      type: 'user',
      timestamp: new Date().toISOString(),
      uuid: generateEventId(),
      parentUuid: startUuid,
      cwd,
      message: { role: 'user', content: 'Hello, world!' },
    }
    store.append(sessionId, userEvent)

    const assistantEvent: SessionEvent = {
      sessionId,
      type: 'assistant',
      timestamp: new Date().toISOString(),
      uuid: generateEventId(),
      parentUuid: userEvent.uuid,
      cwd,
      message: { role: 'assistant', content: 'Hi there!' },
    }
    store.append(sessionId, assistantEvent)

    const snapshot = store.loadMessages(sessionId)
    expect(snapshot.messages).toHaveLength(2)
    expect(snapshot.messages[0]).toEqual({
      id: userEvent.uuid,
      role: 'user',
      content: 'Hello, world!',
    })
    expect(snapshot.messages[1]).toEqual({
      id: assistantEvent.uuid,
      role: 'assistant',
      content: 'Hi there!',
    })
  })

  it('should_skip_system_and_tool_events_in_loadMessages', () => {
    const cwd = '/tmp/test-project'
    const sessionId = store.create(cwd, 'anthropic', 'claude-opus-4-20250514')

    // Read session_start uuid to form a proper parent chain
    const filePath = store.list()[0]!.filePath
    const startEvent = JSON.parse(
      readFileSync(filePath, 'utf-8').trim().split('\n')[0]!,
    ) as SessionEvent
    let lastUuid = startEvent.uuid

    // Add a user message
    const userUuid = generateEventId()
    store.append(sessionId, {
      sessionId,
      type: 'user',
      timestamp: new Date().toISOString(),
      uuid: userUuid,
      parentUuid: lastUuid,
      cwd,
      message: { role: 'user', content: 'Run a tool' },
    })
    lastUuid = userUuid

    // Add a system event — should be skipped
    const systemUuid = generateEventId()
    store.append(sessionId, {
      sessionId,
      type: 'system',
      timestamp: new Date().toISOString(),
      uuid: systemUuid,
      parentUuid: lastUuid,
      cwd,
      message: { role: 'system', content: 'System prompt' },
    })
    lastUuid = systemUuid

    // Add a tool_call event — should be skipped
    const toolCallUuid = generateEventId()
    store.append(sessionId, {
      sessionId,
      type: 'tool_call',
      timestamp: new Date().toISOString(),
      uuid: toolCallUuid,
      parentUuid: lastUuid,
      cwd,
      toolCallId: 'tc_1',
      toolName: 'bash',
      args: { command: 'ls' },
    })
    lastUuid = toolCallUuid

    // Add a tool_result event — should be skipped
    const toolResultUuid = generateEventId()
    store.append(sessionId, {
      sessionId,
      type: 'tool_result',
      timestamp: new Date().toISOString(),
      uuid: toolResultUuid,
      parentUuid: lastUuid,
      cwd,
      toolCallId: 'tc_1',
      result: 'file1.txt\nfile2.txt',
    })
    lastUuid = toolResultUuid

    // Add an assistant message
    const assistantUuid = generateEventId()
    store.append(sessionId, {
      sessionId,
      type: 'assistant',
      timestamp: new Date().toISOString(),
      uuid: assistantUuid,
      parentUuid: lastUuid,
      cwd,
      message: { role: 'assistant', content: 'Done!' },
    })

    const snapshot = store.loadMessages(sessionId)
    expect(snapshot.messages).toHaveLength(2)
    expect(snapshot.messages[0]!.role).toBe('user')
    expect(snapshot.messages[1]!.role).toBe('assistant')
  })

  it('should_restore_provider_and_model_from_session_start_event', () => {
    const cwd = '/tmp/test-project'
    const sessionId = store.create(cwd, 'anthropic', 'claude-opus-4-20250514')

    const snapshot = store.loadMessages(sessionId)
    expect(snapshot.provider).toBe('anthropic')
    expect(snapshot.model).toBe('claude-opus-4-20250514')
  })
})

describe('SessionStore.list', () => {
  function createSessionWithMessage(
    store: SessionStore,
    cwd: string,
    provider: string,
    model: string,
    userMessage: string,
    timestamp?: string,
  ): string {
    const sessionId = store.create(cwd, provider, model)
    const ts = timestamp ?? new Date().toISOString()
    store.append(sessionId, {
      sessionId,
      type: 'user',
      timestamp: ts,
      uuid: generateEventId(),
      parentUuid: null,
      cwd,
      message: { role: 'user', content: userMessage },
    })
    return sessionId
  }

  it('should_list_sessions_for_specific_project', () => {
    const cwd = '/tmp/project-a'
    createSessionWithMessage(store, cwd, 'anthropic', 'claude', 'Hello A')
    createSessionWithMessage(store, '/tmp/project-b', 'anthropic', 'claude', 'Hello B')

    const slug = toProjectSlug(cwd)
    const result = store.list({ projectSlug: slug })

    expect(result).toHaveLength(1)
    expect(result[0]!.projectSlug).toBe(slug)
    expect(result[0]!.firstMessage).toBe('Hello A')
  })

  it('should_list_all_projects_when_no_slug_specified', () => {
    createSessionWithMessage(store, '/tmp/project-a', 'anthropic', 'claude', 'Hello A')
    createSessionWithMessage(store, '/tmp/project-b', 'openai', 'gpt-4', 'Hello B')

    const result = store.list()

    expect(result).toHaveLength(2)
    // Both project slugs should be present
    const slugs = result.map((s) => s.projectSlug)
    expect(slugs).toContain(toProjectSlug('/tmp/project-a'))
    expect(slugs).toContain(toProjectSlug('/tmp/project-b'))
  })

  it('should_respect_limit', () => {
    for (let i = 0; i < 5; i++) {
      createSessionWithMessage(store, '/tmp/project', 'anthropic', 'claude', `Message ${i}`)
    }

    const result = store.list({ limit: 3 })
    expect(result).toHaveLength(3)
  })

  it('should_extract_firstMessage_from_jsonl', () => {
    const longMessage = 'A'.repeat(100)
    createSessionWithMessage(store, '/tmp/project', 'anthropic', 'claude', longMessage)

    const result = store.list()
    expect(result).toHaveLength(1)
    // Should be truncated to 80 chars + "..."
    expect(result[0]!.firstMessage).toBe('A'.repeat(80) + '...')
  })

  it('should_sort_by_updatedAt_descending', () => {
    const id1 = createSessionWithMessage(
      store, '/tmp/project', 'anthropic', 'claude', 'First',
      '2025-01-01T00:00:00.000Z',
    )
    const id2 = createSessionWithMessage(
      store, '/tmp/project', 'anthropic', 'claude', 'Second',
      '2025-06-01T00:00:00.000Z',
    )
    const id3 = createSessionWithMessage(
      store, '/tmp/project', 'anthropic', 'claude', 'Third',
      '2025-03-01T00:00:00.000Z',
    )

    const result = store.list()
    expect(result).toHaveLength(3)
    // id2 (June) should be first, id3 (March) second, id1 (Jan) third
    expect(result[0]!.sessionId).toBe(id2)
    expect(result[1]!.sessionId).toBe(id3)
    expect(result[2]!.sessionId).toBe(id1)
  })
})

describe('SessionStore — branching / time-travel', () => {
  const CWD = '/tmp/test-project'

  /**
   * Helper: create a linear session with N user/assistant pairs.
   * Returns sessionId, the session_start uuid, and all user/assistant event uuids in order.
   */
  function createLinearSession(messageCount: number): {
    sessionId: string
    sessionStartUuid: string
    eventUuids: string[]
  } {
    const sessionId = store.create(CWD, 'anthropic', 'claude')

    // Read back session_start event to get its uuid
    const filePath = store.list()[0]!.filePath
    const content = readFileSync(filePath, 'utf-8')
    const startEvent = JSON.parse(content.trim().split('\n')[0]!) as SessionEvent
    const sessionStartUuid = startEvent.uuid

    const eventUuids: string[] = []
    let lastUuid: string = sessionStartUuid

    for (let i = 0; i < messageCount; i++) {
      const userUuid = generateEventId()
      store.append(sessionId, {
        sessionId,
        type: 'user',
        timestamp: new Date(Date.now() + i * 2000).toISOString(),
        uuid: userUuid,
        parentUuid: lastUuid,
        cwd: CWD,
        message: { role: 'user', content: `User message ${i}` },
      })
      eventUuids.push(userUuid)
      lastUuid = userUuid

      const assistantUuid = generateEventId()
      store.append(sessionId, {
        sessionId,
        type: 'assistant',
        timestamp: new Date(Date.now() + i * 2000 + 1000).toISOString(),
        uuid: assistantUuid,
        parentUuid: lastUuid,
        cwd: CWD,
        message: { role: 'assistant', content: `Assistant reply ${i}` },
      })
      eventUuids.push(assistantUuid)
      lastUuid = assistantUuid
    }

    return { sessionId, sessionStartUuid, eventUuids }
  }

  it('should_include_leafEventUuid_in_snapshot', () => {
    const { sessionId, eventUuids } = createLinearSession(2)
    const snapshot = store.loadMessages(sessionId)

    // The leafEventUuid should be the last assistant event
    expect(snapshot.leafEventUuid).toBe(eventUuids[eventUuids.length - 1])
  })

  it('should_load_full_conversation_when_no_leafEventUuid_specified', () => {
    const { sessionId } = createLinearSession(3)
    const snapshot = store.loadMessages(sessionId)

    expect(snapshot.messages).toHaveLength(6) // 3 user + 3 assistant
    expect(snapshot.leafEventUuid).toBeTruthy()
  })

  it('should_load_partial_conversation_up_to_specified_leaf', () => {
    const { sessionId, eventUuids } = createLinearSession(3)
    // eventUuids: [user0, asst0, user1, asst1, user2, asst2]
    // Load up to asst0 (index 1) — should get user0 + asst0
    const leafUuid = eventUuids[1]!
    const snapshot = store.loadMessages(sessionId, leafUuid)

    expect(snapshot.messages).toHaveLength(2)
    expect(snapshot.messages[0]!.content).toBe('User message 0')
    expect(snapshot.messages[1]!.content).toBe('Assistant reply 0')
    expect(snapshot.leafEventUuid).toBe(leafUuid)
  })

  it('should_load_conversation_up_to_mid_point_leaf', () => {
    const { sessionId, eventUuids } = createLinearSession(3)
    // Load up to asst1 (index 3) — should get user0, asst0, user1, asst1
    const leafUuid = eventUuids[3]!
    const snapshot = store.loadMessages(sessionId, leafUuid)

    expect(snapshot.messages).toHaveLength(4)
    expect(snapshot.messages[0]!.content).toBe('User message 0')
    expect(snapshot.messages[1]!.content).toBe('Assistant reply 0')
    expect(snapshot.messages[2]!.content).toBe('User message 1')
    expect(snapshot.messages[3]!.content).toBe('Assistant reply 1')
    expect(snapshot.leafEventUuid).toBe(leafUuid)
  })

  it('should_detect_single_branch_for_linear_session', () => {
    const { sessionId } = createLinearSession(3)
    const branches = store.listBranches(sessionId)

    expect(branches).toHaveLength(1)
    expect(branches[0]!.messageCount).toBe(6)
    expect(branches[0]!.forkPoint).toBeNull()
  })

  it('should_detect_multiple_branches_after_fork', () => {
    const { sessionId, eventUuids } = createLinearSession(2)
    // eventUuids: [user0, asst0, user1, asst1]
    // Fork from asst0 (index 1): add a new user + assistant branching off
    const forkPointUuid = eventUuids[1]! // asst0

    const branchUserUuid = generateEventId()
    store.append(sessionId, {
      sessionId,
      type: 'user',
      timestamp: new Date(Date.now() + 10000).toISOString(),
      uuid: branchUserUuid,
      parentUuid: forkPointUuid,
      cwd: CWD,
      message: { role: 'user', content: 'Branched user message' },
    })

    const branchAssistantUuid = generateEventId()
    store.append(sessionId, {
      sessionId,
      type: 'assistant',
      timestamp: new Date(Date.now() + 11000).toISOString(),
      uuid: branchAssistantUuid,
      parentUuid: branchUserUuid,
      cwd: CWD,
      message: { role: 'assistant', content: 'Branched assistant reply' },
    })

    const branches = store.listBranches(sessionId)
    expect(branches).toHaveLength(2)

    // Both branches should report forkPoint = asst0
    for (const branch of branches) {
      expect(branch.forkPoint).toBe(forkPointUuid)
    }

    // Original branch: user0, asst0, user1, asst1 = 4 messages
    // New branch: user0, asst0, branchUser, branchAsst = 4 messages
    const messageCounts = branches.map(b => b.messageCount).sort()
    expect(messageCounts).toEqual([4, 4])
  })

  it('should_correctly_report_branch_leaf_uuids', () => {
    const { sessionId, eventUuids } = createLinearSession(2)
    const forkPointUuid = eventUuids[1]! // asst0

    const branchUserUuid = generateEventId()
    store.append(sessionId, {
      sessionId,
      type: 'user',
      timestamp: new Date(Date.now() + 10000).toISOString(),
      uuid: branchUserUuid,
      parentUuid: forkPointUuid,
      cwd: CWD,
      message: { role: 'user', content: 'Branch question' },
    })

    const branches = store.listBranches(sessionId)
    const leafUuids = branches.map(b => b.leafEventUuid).sort()

    // Original leaf = asst1 (index 3), new branch leaf = branchUserUuid
    const expected = [eventUuids[3]!, branchUserUuid].sort()
    expect(leafUuids).toEqual(expected)
  })

  it('should_load_correct_messages_for_each_branch_leaf', () => {
    const { sessionId, eventUuids } = createLinearSession(2)
    // eventUuids: [user0, asst0, user1, asst1]
    const forkPointUuid = eventUuids[1]! // asst0

    const branchUserUuid = generateEventId()
    store.append(sessionId, {
      sessionId,
      type: 'user',
      timestamp: new Date(Date.now() + 10000).toISOString(),
      uuid: branchUserUuid,
      parentUuid: forkPointUuid,
      cwd: CWD,
      message: { role: 'user', content: 'Branched question' },
    })

    const branchAssistantUuid = generateEventId()
    store.append(sessionId, {
      sessionId,
      type: 'assistant',
      timestamp: new Date(Date.now() + 11000).toISOString(),
      uuid: branchAssistantUuid,
      parentUuid: branchUserUuid,
      cwd: CWD,
      message: { role: 'assistant', content: 'Branched answer' },
    })

    // Load original branch
    const originalSnapshot = store.loadMessages(sessionId, eventUuids[3]!)
    expect(originalSnapshot.messages).toHaveLength(4)
    expect(originalSnapshot.messages.map(m => m.content)).toEqual([
      'User message 0',
      'Assistant reply 0',
      'User message 1',
      'Assistant reply 1',
    ])

    // Load new branch
    const branchSnapshot = store.loadMessages(sessionId, branchAssistantUuid)
    expect(branchSnapshot.messages).toHaveLength(4)
    expect(branchSnapshot.messages.map(m => m.content)).toEqual([
      'User message 0',
      'Assistant reply 0',
      'Branched question',
      'Branched answer',
    ])
  })

  it('should_have_no_forkPoint_for_single_linear_branch', () => {
    const { sessionId } = createLinearSession(5)
    const branches = store.listBranches(sessionId)

    expect(branches).toHaveLength(1)
    expect(branches[0]!.forkPoint).toBeNull()
    expect(branches[0]!.messageCount).toBe(10)
  })

  it('should_handle_multiple_forks_from_different_points', () => {
    const { sessionId, eventUuids } = createLinearSession(3)
    // eventUuids: [user0, asst0, user1, asst1, user2, asst2]

    // Fork 1: branch off asst0 (index 1)
    const fork1UserUuid = generateEventId()
    store.append(sessionId, {
      sessionId,
      type: 'user',
      timestamp: new Date(Date.now() + 20000).toISOString(),
      uuid: fork1UserUuid,
      parentUuid: eventUuids[1]!,
      cwd: CWD,
      message: { role: 'user', content: 'Fork1 question' },
    })

    // Fork 2: branch off asst1 (index 3)
    const fork2UserUuid = generateEventId()
    store.append(sessionId, {
      sessionId,
      type: 'user',
      timestamp: new Date(Date.now() + 30000).toISOString(),
      uuid: fork2UserUuid,
      parentUuid: eventUuids[3]!,
      cwd: CWD,
      message: { role: 'user', content: 'Fork2 question' },
    })

    const branches = store.listBranches(sessionId)
    expect(branches).toHaveLength(3) // original + fork1 + fork2

    // Find each branch by its leaf
    const originalBranch = branches.find(b => b.leafEventUuid === eventUuids[5]!)!
    const fork1Branch = branches.find(b => b.leafEventUuid === fork1UserUuid)!
    const fork2Branch = branches.find(b => b.leafEventUuid === fork2UserUuid)!

    // Original branch: forkPoint is asst1 (deepest event with >1 children along its path)
    // Path: session_start -> user0 -> asst0 -> user1 -> asst1 -> user2 -> asst2
    // asst0 has 2 children (user1 + fork1User), asst1 has 2 children (user2 + fork2User)
    // Deepest = asst1 (index 3)
    expect(originalBranch.forkPoint).toBe(eventUuids[3]!)

    // Fork1 branch path: session_start -> user0 -> asst0 -> fork1User
    // asst0 has 2 children → forkPoint = asst0
    expect(fork1Branch.forkPoint).toBe(eventUuids[1]!)

    // Fork2 branch path: session_start -> user0 -> asst0 -> user1 -> asst1 -> fork2User
    // asst0 has 2 children, asst1 has 2 children → deepest = asst1
    expect(fork2Branch.forkPoint).toBe(eventUuids[3]!)
  })

  it('should_report_lastMessage_preview_in_branch_info', () => {
    const { sessionId } = createLinearSession(2)
    const branches = store.listBranches(sessionId)

    expect(branches).toHaveLength(1)
    expect(branches[0]!.lastMessage).toBe('Assistant reply 1')
  })

  it('should_truncate_long_lastMessage_in_branch_info', () => {
    const sessionId = store.create(CWD, 'anthropic', 'claude')

    // Read session_start uuid
    const filePath = store.list()[0]!.filePath
    const content = readFileSync(filePath, 'utf-8')
    const startEvent = JSON.parse(content.trim().split('\n')[0]!) as SessionEvent
    const startUuid = startEvent.uuid

    const userUuid = generateEventId()
    store.append(sessionId, {
      sessionId,
      type: 'user',
      timestamp: new Date().toISOString(),
      uuid: userUuid,
      parentUuid: startUuid,
      cwd: CWD,
      message: { role: 'user', content: 'X'.repeat(200) },
    })

    const branches = store.listBranches(sessionId)
    expect(branches[0]!.lastMessage).toBe('X'.repeat(80) + '...')
  })

  it('should_sort_branches_by_updatedAt_descending', () => {
    const { sessionId, eventUuids } = createLinearSession(2)
    const forkPointUuid = eventUuids[1]! // asst0

    // Add a branch with an earlier timestamp
    const branchUserUuid = generateEventId()
    store.append(sessionId, {
      sessionId,
      type: 'user',
      timestamp: '2020-01-01T00:00:00.000Z', // very old timestamp
      uuid: branchUserUuid,
      parentUuid: forkPointUuid,
      cwd: CWD,
      message: { role: 'user', content: 'Old branch' },
    })

    const branches = store.listBranches(sessionId)
    expect(branches).toHaveLength(2)
    // Original branch (recent) should come first
    expect(branches[0]!.leafEventUuid).toBe(eventUuids[3]!) // asst1
    expect(branches[1]!.leafEventUuid).toBe(branchUserUuid) // old branch
  })
})

describe('SessionStore.cleanup', () => {
  it('should_delete_files_older_than_retention_days', () => {
    const cwd = '/tmp/project'
    const sessionId = store.create(cwd, 'anthropic', 'claude')

    // Manually set file mtime to 60 days ago
    const filePath = store.list()[0]!.filePath
    // utimesSync 已在顶部 import
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
    utimesSync(filePath, oldDate, oldDate)

    store.cleanup(30)

    const remaining = store.list()
    expect(remaining).toHaveLength(0)
  })
})
