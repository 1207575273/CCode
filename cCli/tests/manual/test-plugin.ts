// tests/manual/test-plugin.ts
// 手动测试：验证 Runtime Plugin 发现与加载
// 运行: npx tsx tests/manual/test-plugin.ts

import { pluginRegistry } from '../../src/plugin/registry.js'
import { ToolRegistry } from '../../src/tools/core/registry.js'

const toolReg = new ToolRegistry()
await pluginRegistry.discover(toolReg)

const plugins = pluginRegistry.list()
console.log('Loaded plugins:', JSON.stringify(plugins, null, 2))

const commands = pluginRegistry.getCommands()
console.log('Commands:', commands.map(c => c.name))

// 模拟执行命令
for (const cmd of commands) {
  console.log(`\nExecuting /${cmd.name}:`)
  // 设置 bridge mock
  pluginRegistry.setBridge({
    injectInput: (t) => console.log(`  [injectInput] ${t}`),
    submitInput: (t) => console.log(`  [submitInput] ${t}`),
    appendSystemMessage: (t) => console.log(`  [system] ${t}`),
    getSessionId: () => 'test-session',
    getModel: () => 'test-model',
    getProvider: () => 'test-provider',
  })
  await cmd.execute([])
}

process.exit(0)
