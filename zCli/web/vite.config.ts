import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // HMR 通过 Vite 直连（Bridge Server 不代理 HMR WebSocket）
    hmr: {
      port: 5173,
    },
  },
  build: {
    outDir: 'dist',
  },
})
