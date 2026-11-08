import { contextBridge, ipcRenderer } from 'electron'
import type { KithoardApi } from '@shared/api'
import { CHANNELS } from '@shared/channels'

// 只暴露白名单方法；渲染层拿不到 ipcRenderer 本身，也就无法自己拼通道
const api: KithoardApi = {
  source: {
    list: () => ipcRenderer.invoke(CHANNELS.sourceList)
  },
  search: {
    run: (query) => ipcRenderer.invoke(CHANNELS.searchRun, query)
  },
  asset: {
    detail: (assetId) => ipcRenderer.invoke(CHANNELS.assetDetail, { assetId }),
    recent: (limit) => ipcRenderer.invoke(CHANNELS.assetRecent, { limit })
  },
  settings: {
    get: (key) => ipcRenderer.invoke(CHANNELS.settingsGet, { key }),
    set: (key, value) => ipcRenderer.invoke(CHANNELS.settingsSet, { key, value })
  },
  clipboard: {
    writeText: (text) => ipcRenderer.invoke(CHANNELS.copyText, { text })
  }
}

contextBridge.exposeInMainWorld('api', api)
