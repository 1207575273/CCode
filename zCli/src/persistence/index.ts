// src/persistence/index.ts

import { join } from 'node:path'
import { homedir } from 'node:os'
import { SessionStore } from './session-store.js'

export { SessionStore } from './session-store.js'
export type { SessionEvent, SessionSnapshot, SessionSummary, BranchInfo, SubagentSnapshot, SubagentSnapshotEvent } from './session-types.js'
export type { SessionEventType } from './session-types.js'
export {
  toProjectSlug,
  generateSessionId,
  generateEventId,
  formatSessionFilename,
  extractSessionId,
  getGitBranch,
} from './session-utils.js'

/** 全局单例，存储路径 ~/.ccode/sessions/ */
export const sessionStore = new SessionStore(join(homedir(), '.ccode', 'sessions'))

export { getDb, createDb, closeDb } from './db.js'
