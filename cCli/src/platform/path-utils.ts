// src/platform/path-utils.ts
import { resolve, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { detectPlatform } from './detector.js'

/** 进程内 OS home 目录不变，缓存解析结果，避免收口后众多调用点重复同步 existsSync 探测。 */
let _homeDirCache: string | undefined

/**
 * 防御式解析真实 home 目录 —— 绝不依赖单一来源。
 *
 * 背景：os.homedir() 在多数环境可靠，但在沙箱/容器/CI/受限 shell 下可能
 * 返回 '/'、空串或不存在的路径，导致配置写到错误位置。这里逐源回退并用
 * existsSync 校验，保证返回的一定是「真实存在的目录」。
 *
 * 优先级（命中一个存在的目录即返回）：
 *   1. os.homedir()
 *   2. Windows: %USERPROFILE% -> %HOMEDRIVE%%HOMEPATH%；类 Unix: $HOME
 *   3. 全部失败：返回 os.homedir() 原值（保持可预期），再兜底 os.tmpdir()
 *
 * 结果在进程内缓存（OS home 不随运行时变化）。注意：这里不读 CCODE_HOME，
 * 因此缓存不影响 CCODE_HOME 覆盖（覆盖逻辑在 ccodeHome() 里，每次实时读取）。
 */
export function resolveHomeDir(): string {
  if (_homeDirCache !== undefined) return _homeDirCache
  _homeDirCache = computeHomeDir()
  return _homeDirCache
}

function computeHomeDir(): string {
  const fromOs = homedir()
  const candidates: (string | undefined)[] = [fromOs]

  if (process.platform === 'win32') {
    candidates.push(process.env['USERPROFILE'])
    const homeDrive = process.env['HOMEDRIVE']
    const homePath = process.env['HOMEPATH']
    if (homeDrive && homePath) candidates.push(homeDrive + homePath)
  } else {
    candidates.push(process.env['HOME'])
  }

  for (const candidate of candidates) {
    if (candidate && candidate !== '/' && existsSync(candidate)) return candidate
  }

  // 全部不可用：优先返回 os.homedir() 原值（即便不存在也比随机路径可预期），最后兜底临时目录
  return fromOs && fromOs !== '/' ? fromOs : tmpdir()
}

/**
 * ccode 全局配置根目录（默认 <home>/.ccode）。
 *
 * 支持 CCODE_HOME 环境变量显式覆盖：用于测试隔离（重定向到临时目录，
 * 避免污染真实 ~/.ccode）或特殊部署。覆盖值直接作为配置根，不再追加 .ccode。
 *
 * 注意：不缓存（每次实时读 CCODE_HOME，保留运行时可变）；但 home 部分复用
 * memoized 的 resolveHomeDir()。又因部分调用点是模块级常量（如 sessionStore、
 * DEFAULT_FILE_PATH、MCP_CONFIG_PATHS）在 import 期求值，CCODE_HOME 须在进程
 * 启动前设置才能对它们全部生效。
 */
export function ccodeHome(): string {
  const override = process.env['CCODE_HOME']
  if (override && override.trim()) return override
  return join(resolveHomeDir(), '.ccode')
}

/**
 * 拼接 ccode 配置根下的子路径，是全仓访问 `~/.ccode/*` 的唯一出口。
 *
 * 用 `ccodePath('sessions')` 取代散落各处的 `join(homedir(), '.ccode', 'sessions')`，
 * 使 CCODE_HOME 覆盖与防御式 home 解析对所有 .ccode 子路径统一生效（含测试隔离）。
 */
export function ccodePath(...segments: string[]): string {
  return join(ccodeHome(), ...segments)
}

/**
 * MSYS/Git Bash 路径转 Windows 原生路径
 * /c/Users/foo → C:\Users\foo
 * /d/work      → D:\work
 * 非 MSYS 格式或非 Windows 平台直接原样返回
 */
function msysToWin(p: string): string {
  // 匹配 /x/ 或 /x 开头（x 为单字母盘符）
  const match = /^\/([a-zA-Z])(\/.*)?$/.exec(p)
  if (!match) return p
  const drive = match[1]!.toUpperCase()
  const rest = (match[2] ?? '').replace(/\//g, '\\')
  return `${drive}:${rest || '\\'}`
}

/**
 * 将可能的 MSYS 路径 + 相对路径解析为当前平台的绝对路径
 * Windows 上先把 MSYS 格式转为 Win 路径再 resolve
 * 其他平台直接 resolve
 */
export function resolvePath(cwd: string, rawPath: string): string {
  const { isWindows } = detectPlatform()
  if (isWindows) {
    return resolve(msysToWin(cwd), msysToWin(rawPath))
  }
  return resolve(cwd, rawPath)
}
