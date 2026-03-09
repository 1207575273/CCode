import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
    },
  },
  resolve: {
    alias: {
      '@core': new URL('./src/core', import.meta.url).pathname,
      '@providers': new URL('./src/providers', import.meta.url).pathname,
      '@tools': new URL('./src/tools', import.meta.url).pathname,
      '@ui': new URL('./src/ui', import.meta.url).pathname,
      '@platform': new URL('./src/platform', import.meta.url).pathname,
      '@commands': new URL('./src/commands', import.meta.url).pathname,
      '@persistence': new URL('./src/persistence', import.meta.url).pathname,
      '@observability': new URL('./src/observability', import.meta.url).pathname,
      '@config': new URL('./src/config', import.meta.url).pathname,
      '@utils': new URL('./src/utils', import.meta.url).pathname,
    },
  },
})
