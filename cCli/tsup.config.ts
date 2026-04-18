import { defineConfig } from 'tsup'
import { cp } from 'node:fs/promises'

export default defineConfig({
  entry: ['bin/ccli.ts'],
  outDir: 'dist/bin',
  format: ['esm'],
  target: 'node20',
  splitting: false,
  sourcemap: true,
  clean: true,
  banner: {
    // ESM 产物需要 createRequire 才能让 CJS 依赖（如 fast-glob）内部的 require('os') 工作
    // 否则 esbuild 生成的 __require shim 会抛 "Dynamic require of X is not supported"
    js: `#!/usr/bin/env node
import { createRequire as __ccodeCreateRequire } from 'node:module';
const require = __ccodeCreateRequire(import.meta.url);`,
  },
  tsconfig: 'tsconfig.build.json',
  // 全量 bundle 所有 npm 依赖，消除运行时的文件 I/O 瓶颈（3.3s → ~0.4s）
  // noExternal: [/.*/] 会覆盖字段 external 的效果，真正 external 靠下方 force-external plugin 拦截
  noExternal: [/.*/],
  esbuildPlugins: [
    // native addon / WASM 不能 inline bundle，必须在运行时从 node_modules 解析
    // libsql 内部 require('@libsql/<platform>-<arch>-<toolchain>') 是平台特定二进制
    // jieba-wasm 加载 .wasm 文件的路径依赖 node_modules 结构
    {
      name: 'force-external',
      setup(build) {
        build.onResolve({ filter: /^(libsql|jieba-wasm)(\/.*)?$/ }, (args) => ({
          path: args.path,
          external: true,
        }))
      },
    },
    // ink 的 react-devtools-core 仅开发调试时触发，生产永远不走到，但源码里静态 import 阻止 bundle
    // 把它替换为空 stub（export default {}）让 bundle 能通过
    {
      name: 'stub-react-devtools-core',
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, (args) => ({
          path: args.path,
          namespace: 'stub-devtools',
        }))
        build.onLoad({ filter: /.*/, namespace: 'stub-devtools' }, () => ({
          contents: 'export default {}',
          loader: 'js',
        }))
      },
    },
  ],
  // bundle 后 src/skills/engine/store.ts 里 join(__dirname, '..', 'builtin')
  // 期望 dist/skills/builtin 存在 —— 构建完成后把源码资源复制过去
  async onSuccess() {
    await cp('src/skills/builtin', 'dist/skills/builtin', { recursive: true })
    console.log('[tsup] copied skills/builtin → dist/skills/builtin')
  },
})
