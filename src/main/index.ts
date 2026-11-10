import path from 'node:path'
import { app, BrowserWindow, protocol } from 'electron'
import { closeDatabase, consumeRecoveryNotice, openDatabase } from './db'
import { initLogging, log } from './log'
import { registerIpc } from './ipc'
import { registerThumbProtocol, THUMB_SCHEME } from './protocol'
import { runKeyMigration } from './security/key-migration-startup'
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
    // 历史明文 Key 迁移必须在建窗口前完成；迁移失败也不能阻断启动
    runKeyMigration(userData)
    // 数据库层不依赖日志模块；恢复事件在这里记一次，排查时有迹可循
    const recovery = consumeRecoveryNotice()
    if (recovery) log.warn(`db restored from .bak: ${recovery.detail}`)
    registerThumbProtocol(path.join(userData, 'cache', 'thumbs'))
    const runtime = registerIpc({ userDataDir: userData })
    createMainWindow()

    // 先停下载再关库：引擎的异步写入不能撞上已关闭的 SQLite 连接
    app.on('before-quit', () => {
      runtime.shutdown()
      closeDatabase()
    })

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
