// src/config/a2a-config.ts
/**
 * A2A 受信任 Agent 白名单的持久化模块。
 *
 * 设计依据：总体方案 §5.3 / D-5「服务发现分拉取与信任两步」。
 * M1 持久化到本地 JSON 文件（~/.ccode/a2a-trusted.json）；
 * M2 将迁移到 libSQL agent_registry 表。
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ccodePath } from '../platform/path-utils.js'
import type { TrustedAgent } from '../a2a/types.js'

/** 默认存储路径（导出供 /a2a 命令同步读写时复用同一路径） */
export const DEFAULT_FILE_PATH = ccodePath('a2a-trusted.json')

/**
 * 对鉴权 token 进行脱敏处理。
 *
 * - 有 token：展示前 8 位 + '...' + 后 4 位，例：`sk-1234...cdef`
 * - 无 token（undefined）：返回 `(none)`
 *
 * 任何需要输出 TrustedAgent.authToken 的地方都必须经过此函数，
 * 严禁将原始 token 打印到日志或 UI。
 */
export function maskToken(token: string | undefined): string {
  if (token === undefined) return '(none)'
  if (token.length <= 12) {
    // token 较短时只展示前 4 位 + '...'，避免暴露过多
    return token.slice(0, 4) + '...'
  }
  return token.slice(0, 8) + '...' + token.slice(-4)
}

/**
 * A2ATrustStore — 受信任 Agent 白名单的读写管理器。
 *
 * 并发安全说明：M1 为 CLI 单进程场景，不做文件锁；
 * 写操作采用"先写 .tmp 再 rename"原子操作，避免写入中断导致数据损坏。
 */
export class A2ATrustStore {
  readonly #filePath: string

  constructor(filePath: string = DEFAULT_FILE_PATH) {
    this.#filePath = filePath
  }

  /**
   * 从磁盘加载白名单列表。
   * 文件不存在时静默返回空数组，不抛异常。
   */
  async load(): Promise<TrustedAgent[]> {
    try {
      const raw = await readFile(this.#filePath, 'utf-8')
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed as TrustedAgent[]
    } catch (err) {
      // ENOENT（文件不存在）静默返回空数组；其他 IO 错误同样不抛，降级为空列表
      if (isNodeError(err) && err.code === 'ENOENT') return []
      // JSON 解析失败等情况也不中断启动
      return []
    }
  }

  /**
   * 添加或更新一条受信任 Agent 记录。
   *
   * url 去重策略：同 url 视为同一条记录。
   * - 若 url 已存在：覆盖除 id / addedAt 以外的所有字段（保留原始 id 和首次加入时间）。
   * - 若 url 不存在：生成新 id（randomUUID）和 addedAt（ISO 字符串）后写入。
   *
   * 返回最终持久化的条目。
   */
  async add(agent: Omit<TrustedAgent, 'id' | 'addedAt'>): Promise<TrustedAgent> {
    const list = await this.load()
    const existingIndex = list.findIndex((a) => a.url === agent.url)

    let entry: TrustedAgent
    if (existingIndex >= 0) {
      // 已存在：保留原始 id 和 addedAt，其余字段以新传入值覆盖
      const existing = list[existingIndex]!
      // exactOptionalPropertyTypes：可选字段 alias / authToken 需条件展开
      entry = {
        id: existing.id,
        url: agent.url,
        name: agent.name,
        securityScheme: agent.securityScheme,
        addedAt: existing.addedAt,
        ...(agent.alias !== undefined ? { alias: agent.alias } : {}),
        ...(agent.authToken !== undefined ? { authToken: agent.authToken } : {}),
      }
      list[existingIndex] = entry
    } else {
      // 新增：生成 id 和 addedAt
      entry = {
        id: randomUUID(),
        url: agent.url,
        name: agent.name,
        securityScheme: agent.securityScheme,
        addedAt: new Date().toISOString(),
        ...(agent.alias !== undefined ? { alias: agent.alias } : {}),
        ...(agent.authToken !== undefined ? { authToken: agent.authToken } : {}),
      }
      list.push(entry)
    }

    await this.#atomicWrite(list)
    return entry
  }

  /**
   * 按 id 删除一条记录。
   * 存在并成功删除返回 true，id 不存在返回 false。
   */
  async remove(id: string): Promise<boolean> {
    const list = await this.load()
    const index = list.findIndex((a) => a.id === id)
    if (index < 0) return false

    list.splice(index, 1)
    await this.#atomicWrite(list)
    return true
  }

  /**
   * 返回全量白名单列表（load 的语义别名，供外部代码使用更语义化的命名）。
   */
  async list(): Promise<TrustedAgent[]> {
    return this.load()
  }

  /**
   * 按 url 查找第一条匹配记录。
   * 未命中返回 undefined。
   */
  async findByUrl(url: string): Promise<TrustedAgent | undefined> {
    const list = await this.load()
    return list.find((a) => a.url === url)
  }

  /**
   * 原子写：先写 <path>.tmp，写成功后 rename 到目标路径。
   * 确保父目录存在（recursive mkdir）。
   */
  async #atomicWrite(data: TrustedAgent[]): Promise<void> {
    const dir = dirname(this.#filePath)
    await mkdir(dir, { recursive: true })

    const tmpPath = this.#filePath + '.tmp'
    await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
    await rename(tmpPath, this.#filePath)
  }
}

/** 类型守卫：判断是否为带 code 属性的 Node.js 系统错误 */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}
