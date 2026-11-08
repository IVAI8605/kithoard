import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// 单测只覆盖纯逻辑，不触碰 Electron 与 SQLite，保证无需原生模块也能跑门禁
export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url))
    }
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node'
  }
})
