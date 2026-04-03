// src/platform/detector.ts
import os from 'node:os'

export type Platform = 'win32' | 'linux' | 'darwin'

export interface PlatformInfo {
  platform: Platform
  isWindows: boolean
  isLinux: boolean
  isMac: boolean
  arch: string
  homeDir: string
  ccodeDir: string
}

const SUPPORTED_PLATFORMS = new Set<string>(['win32', 'linux', 'darwin'])

/** 模块级缓存，进程生命周期内只计算一次 */
let _cached: PlatformInfo | undefined

export function detectPlatform(): PlatformInfo {
  if (_cached) return _cached
  const raw = os.platform()
  const platform: Platform = SUPPORTED_PLATFORMS.has(raw) ? (raw as Platform) : 'linux'
  _cached = {
    platform,
    isWindows: platform === 'win32',
    isLinux: platform === 'linux',
    isMac: platform === 'darwin',
    arch: os.arch(),
    homeDir: os.homedir(),
    ccodeDir: `${os.homedir()}/.ccode`,
  }
  return _cached
}
