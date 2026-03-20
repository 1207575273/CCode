// scripts/ensure-web.js
// 检测 web/node_modules 是否存在，不存在则自动安装依赖

const { existsSync } = require('fs')
const { execSync } = require('child_process')
const { join } = require('path')

const webDir = join(__dirname, '..', 'web')
const nodeModules = join(webDir, 'node_modules')

if (!existsSync(nodeModules)) {
  console.log('web/node_modules not found, installing...')
  execSync('pnpm install', { cwd: webDir, stdio: 'inherit' })
}
