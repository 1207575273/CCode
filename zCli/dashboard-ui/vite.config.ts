import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:9800', ws: true },
      '/api': { target: 'http://localhost:9800' },
    },
  },
  build: {
    outDir: 'dist',
  },
})
