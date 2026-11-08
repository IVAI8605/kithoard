import path from 'node:path'
import { app, BrowserWindow, protocol } from 'electron'
import { closeDatabase, openDatabase } from './db'
import { initLogging, log } from './log'
import { registerIpc } from './ipc'
import { registerThumbProtocol, THUMB_SCHEME } from './protocol'
import { createMainWindow } from './window'

// 自定义协议必须在 app ready 之前登记为「标准 + 安全」，否则渲染层无法当图片源使用
protocol.registerSchemesAsPrivileged([
  { scheme: THUMB_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

app
  .whenReady()
  .then(() => {
    const userData = app.getPath('userData')
    initLogging(userData)
    openDatabase(userData)
    registerThumbProtocol(path.join(userData, 'cache', 'thumbs'))
    registerIpc({ userDataDir: userData })
    createMainWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })
  .catch((error: unknown) => {
    log.error(`startup failed: ${error instanceof Error ? error.message : String(error)}`)
    app.quit()
  })

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  closeDatabase()
})
