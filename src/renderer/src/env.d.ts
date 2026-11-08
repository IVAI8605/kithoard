/// <reference types="vite/client" />
import type { KithoardApi } from '@shared/api'

declare global {
  interface Window {
    api: KithoardApi
  }
  /** 由 electron.vite.config.ts 在构建时从 package.json 注入 */
  const __APP_VERSION__: string
}

export {}
