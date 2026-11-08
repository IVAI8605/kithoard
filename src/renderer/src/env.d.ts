/// <reference types="vite/client" />
import type { KithoardApi } from '@shared/api'

declare global {
  interface Window {
    api: KithoardApi
  }
}

export {}
