/**
 * InstanceRegistry — 本地会话发现的 lockfile 注册表
 *
 * 每个 CCode 会话启动时写一张「名片」到
 * `<homedir>/.ccode/instances/<sessionId>.json`，
 * 其他会话扫描该目录即可发现彼此（A2A 端口动态，靠名片记录）。
 *
 * 设计要点：
 * - 原子写：先写 <file>.tmp，再 renameSync，避免读到半写文件
 * - 死亡判定（双判合取）：心跳过期(>30s) AND 进程不存在
 * - 构造函数依赖注入，方便单元测试注入 now / isAlive / hostname 等
 */

import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { hostname as osHostname, userInfo } from 'node:os'
import { ccodePath } from '../platform/path-utils.js'

// ─────────────────────────────────────────────────────────────
// 数据结构
// ─────────────────────────────────────────────────────────────

/** 会话名片——写入磁盘的 JSON 结构 */
export interface InstanceCard {
  sessionId: string
  pid: number
  port: number
  agentCardUrl: string      // http://127.0.0.1:<port>/.well-known/agent-card.json
  projectName: string
  cwd: string
  gitBranch?: string
  hostname: string
  osUser: string
  startedAt: string         // ISO 字符串
  lastHeartbeat: string     // ISO 字符串
}

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** 心跳超时阈值（毫秒），超过后结合进程状态判定死亡 */
const HEARTBEAT_TIMEOUT_MS = 30_000

// ─────────────────────────────────────────────────────────────
// defaultIsAlive
// ─────────────────────────────────────────────────────────────

/**
 * 默认进程存活检测。
 * - 发送 signal 0 成功 -> 存活
 * - ESRCH（进程不存在）-> 死亡
 * - EPERM（无权限，Windows 常见）-> 视为存活
 * - 其他异常 -> 保守视为存活
 */
export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') {
      return false
    }
    // EPERM 或其他未知错误 -> 保守存活
    return true
  }
}

// ─────────────────────────────────────────────────────────────
// InstanceRegistry
// ─────────────────────────────────────────────────────────────

/** InstanceRegistry 构造参数（均可选，便于测试注入） */
export interface InstanceRegistryDeps {
  /** lockfile 存放目录，默认 ~/.ccode/instances */
  dir?: string
  /** 返回当前毫秒时间戳，默认 Date.now */
  now?: () => number
  /** 当前进程 pid，默认 process.pid */
  selfPid?: number
  /** 主机名，默认 os.hostname() */
  hostname?: string
  /** 操作系统用户名，默认 os.userInfo().username */
  osUser?: string
  /** 进程存活检测函数，默认 defaultIsAlive */
  isAlive?: (pid: number) => boolean
}

export class InstanceRegistry {
  private readonly dir: string
  private readonly now: () => number
  private readonly selfPid: number
  private readonly hostname: string
  private readonly osUser: string
  private readonly isAlive: (pid: number) => boolean

  constructor(deps: InstanceRegistryDeps = {}) {
    this.dir = deps.dir ?? ccodePath('instances')
    this.now = deps.now ?? (() => Date.now())
    this.selfPid = deps.selfPid ?? process.pid
    this.hostname = deps.hostname ?? osHostname()
    this.osUser = deps.osUser ?? userInfo().username
    this.isAlive = deps.isAlive ?? defaultIsAlive
  }

  // ─────────────────────────────────────────────
  // writeSelf — 写出名片（原子写）
  // ─────────────────────────────────────────────

  /**
   * 写出自己的名片到 `<dir>/<sessionId>.json`。
   * - hostname / osUser / lastHeartbeat 由实例自动填充
   * - startedAt 不传则取 now()
   * - 原子写：tmp -> rename
   */
  writeSelf(
    card: Omit<InstanceCard, 'hostname' | 'osUser' | 'startedAt' | 'lastHeartbeat'> & {
      startedAt?: string
    },
  ): void {
    this.ensureDir()

    const nowIso = new Date(this.now()).toISOString()
    const full: InstanceCard = {
      ...card,
      hostname: this.hostname,
      osUser: this.osUser,
      startedAt: card.startedAt ?? nowIso,
      lastHeartbeat: nowIso,
    }

    this.atomicWrite(card.sessionId, full)
  }

  // ─────────────────────────────────────────────
  // heartbeat — 更新 lastHeartbeat
  // ─────────────────────────────────────────────

  /**
   * 更新指定 sessionId 名片的 lastHeartbeat 为当前时间（原子写）。
   * 文件不存在时静默忽略（会话已退出或被 reap）。
   */
  heartbeat(sessionId: string): void {
    const filePath = join(this.dir, `${sessionId}.json`)
    const card = this.readCard(filePath)
    if (card === null) {
      return
    }

    const updated: InstanceCard = {
      ...card,
      lastHeartbeat: new Date(this.now()).toISOString(),
    }
    this.atomicWrite(sessionId, updated)
  }

  // ─────────────────────────────────────────────
  // discover — 扫描目录，返回活跃的其他会话
  // ─────────────────────────────────────────────

  /**
   * 扫描 dir，返回满足以下全部条件的名片：
   * 1. sessionId !== selfSessionId（排除自己）
   * 2. hostname === 本机 hostname（只返回本机会话）
   * 3. osUser === 本机用户（只返回同一用户的会话）
   * 4. 未死亡（心跳新鲜 OR 进程仍存活）
   *
   * @param selfSessionId 当前会话的 sessionId，用于排除自身
   */
  discover(selfSessionId: string): InstanceCard[] {
    if (!existsSync(this.dir)) {
      return []
    }

    let entries: string[]
    try {
      entries = readdirSync(this.dir)
    } catch {
      return []
    }

    const results: InstanceCard[] = []

    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue
      }
      const filePath = join(this.dir, entry)
      const card = this.readCard(filePath)
      if (card === null) {
        continue
      }

      // 排除自己
      if (card.sessionId === selfSessionId) {
        continue
      }

      // 仅本机同用户
      if (card.hostname !== this.hostname || card.osUser !== this.osUser) {
        continue
      }

      // 过滤死亡名片（双判合取：心跳过期 AND 进程死）
      if (this.isDead(card)) {
        continue
      }

      results.push(card)
    }

    return results
  }

  // ─────────────────────────────────────────────
  // reapOrphans — 删除死亡名片，返回被删 sessionId 列表
  // ─────────────────────────────────────────────

  /**
   * 扫描 dir，删除所有死亡名片（心跳过期 AND 进程死），
   * 返回被删除的 sessionId 列表。
   */
  reapOrphans(): string[] {
    if (!existsSync(this.dir)) {
      return []
    }

    let entries: string[]
    try {
      entries = readdirSync(this.dir)
    } catch {
      return []
    }

    const reaped: string[] = []

    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue
      }
      const filePath = join(this.dir, entry)
      const card = this.readCard(filePath)
      if (card === null) {
        continue
      }

      if (this.isDead(card)) {
        try {
          rmSync(filePath, { force: true })
          reaped.push(card.sessionId)
        } catch {
          // 删除失败静默忽略（并发 reap 场景）
        }
      }
    }

    return reaped
  }

  // ─────────────────────────────────────────────
  // removeSelf — 删除自己的 lockfile
  // ─────────────────────────────────────────────

  /**
   * 删除指定 sessionId 的名片文件（会话退出时调用）。
   * 文件不存在时静默忽略。
   */
  removeSelf(sessionId: string): void {
    const filePath = join(this.dir, `${sessionId}.json`)
    try {
      rmSync(filePath, { force: true })
    } catch {
      // 已删除或不存在，静默忽略
    }
  }

  // ─────────────────────────────────────────────
  // 私有辅助
  // ─────────────────────────────────────────────

  /** 确保 lockfile 目录存在 */
  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true })
  }

  /**
   * 原子写：先写 <sessionId>.tmp，再 rename 到 <sessionId>.json。
   * 确保读者不会读到半写文件。
   */
  private atomicWrite(sessionId: string, card: InstanceCard): void {
    this.ensureDir()
    const targetPath = join(this.dir, `${sessionId}.json`)
    const tmpPath = join(this.dir, `${sessionId}.tmp`)
    const content = JSON.stringify(card, null, 2)
    writeFileSync(tmpPath, content, 'utf-8')
    renameSync(tmpPath, targetPath)
  }

  /**
   * 读取并解析名片文件。
   * 文件不存在或 JSON 损坏时返回 null（跳过，不抛异常）。
   */
  private readCard(filePath: string): InstanceCard | null {
    try {
      const raw = readFileSync(filePath, 'utf-8')
      return JSON.parse(raw) as InstanceCard
    } catch {
      return null
    }
  }

  /**
   * 判断名片是否死亡。
   * 死亡条件（双判合取）：心跳超过 30s AND 进程不存在。
   * 两者必须同时成立，任一不满足则视为存活。
   */
  private isDead(card: InstanceCard): boolean {
    const lastBeat = new Date(card.lastHeartbeat).getTime()
    const heartbeatExpired = this.now() - lastBeat > HEARTBEAT_TIMEOUT_MS

    if (!heartbeatExpired) {
      // 心跳新鲜，不管进程状态都视为存活
      return false
    }

    // 心跳过期，再检查进程是否存活
    const processAlive = this.isAlive(card.pid)
    return !processAlive
  }
}
