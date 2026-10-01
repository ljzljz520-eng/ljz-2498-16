import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 开发期把 /api 代理到零依赖 Node 校对服务；生产期同源由该服务托管静态资源。
export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
})
