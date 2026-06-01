// 测试隔离：把 ccode 配置根（CCODE_HOME）重定向到临时目录，
// 避免任何测试经由 configManager 单例 / initialize() 污染真实 ~/.ccode。
// 早于测试文件导入执行（vitest setupFiles），确保单例构造时已读到覆盖值。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

if (!process.env['CCODE_HOME']) {
  const dir = join(tmpdir(), `ccode-test-home-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  process.env['CCODE_HOME'] = dir
}
