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
    // 输出到主 dist/web/，和 CLI（dist/bin/）统一在 dist/ 下
    // npm publish 时一起打包，--web 启动时 Bridge Server 从此目录托管静态资源
    outDir: '../dist/web',
    emptyOutDir: true,
    // 代码分割：按依赖分包，减小首屏加载
    rollupOptions: {
      output: {
        manualChunks: {
          // React 核心（几乎不变，长缓存）
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          // Markdown 渲染（只在 MessageBubble 用）
          'vendor-markdown': ['react-markdown', 'remark-gfm', 'rehype-highlight'],
          // 图表（只在 OverviewPage 用，懒加载后独立 chunk）
          'vendor-charts': ['recharts'],
        },
      },
    },
    // 提高警告阈值（分包后单包不会超）
    chunkSizeWarningLimit: 400,
    // 跳过 gzip 体积计算（省 ~2 秒，CI 上更明显）
    reportCompressedSize: false,
    // 不生成 sourcemap（生产包不需要调试）
    sourcemap: false,
    // CSS 用 esbuild 压缩（比默认的 lightningcss 更快）
    cssMinify: 'esbuild',
  },
})
