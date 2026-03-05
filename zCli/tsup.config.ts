import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['bin/zcli.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'node20',
  splitting: false,
  sourcemap: true,
  clean: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  tsconfig: 'tsconfig.build.json',
})
