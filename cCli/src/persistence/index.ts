// src/persistence/index.ts

import { ccodePath } from '../platform/path-utils.js'
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
export const sessionStore = new SessionStore(ccodePath('sessions'))

export { getDb, createDb, closeDb, ensureMemoryVectors, getStoredEmbeddingDimension } from './db.js'
