// 最小 Ink 兼容性测试：检测 Bun 能否运行带 useInput 的 Ink 应用
// 用法：bun tests/integration/_ink_bun_test.mjs
//       npx tsx tests/integration/_ink_bun_test.mjs

import React from 'react'
import { render, Text, useInput, useApp } from 'ink'

const isBun = typeof globalThis.Bun !== 'undefined'
const runtime = isBun ? `Bun ${Bun.version}` : `Node.js ${process.version}`

function App() {
  const { exit } = useApp()

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      exit()
    }
  })

  return React.createElement(Text, null, `[${runtime}] Ink + useInput 正常！按 q 退出`)
}

console.log(`测试 Ink useInput [${runtime}]...`)
console.log(`process.stdin.isTTY: ${process.stdin.isTTY}`)
console.log(`typeof setRawMode: ${typeof process.stdin.setRawMode}`)

try {
  const { unmount } = render(React.createElement(App), { exitOnCtrlC: false })
  // 3 秒后自动退出
  setTimeout(() => {
    unmount()
    console.log('\n✅ Ink 运行 3 秒无报错，兼容性 OK')
    process.exit(0)
  }, 3000)
} catch (e) {
  console.error('❌ Ink 渲染失败:', e.message)
  process.exit(1)
}
