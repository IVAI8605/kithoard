import path from 'node:path'
import { app, BrowserWindow, protocol } from 'electron'
import { closeDatabase, consumeRecoveryNotice, openDatabase } from './db'
import { initLogging, log } from './log'
import { registerIpc } from './ipc'
import { registerThumbProtocol, THUMB_SCHEME } from './protocol'
import { runKeyMigration } from './security/key-migration-startup'
import { createTray } from './tray'
import {
  createMainWindow,
  markQuitting,
  navigateMainWindow,
  showMainWindow
} from './window'

// 自定义协议必须在 app ready 之前登记为「标准 + 安全」，否则渲染层无法当图片源使用
protocol.registerSchemesAsPrivileged([
  { scheme: THUMB_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

// 常驻托盘的应用必须单实例：否则第二次启动会多出一个托盘图标，并再开一份数据库连接
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // 已经运行时再次启动（例如用户点了桌面快捷方式），只把已有窗口唤到前台
  app.on('second-instance', () => showMainWindow())

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

      const tray = createTray({
        onOpenHome: () => {
          log.info('tray action=openHome')
          showMainWindow()
        },
        onOpenSettings: () => {
          log.info('tray action=openSettings')
          navigateMainWindow('settings')
        },
        onQuit: () => {
          log.info('tray action=quit')
          app.quit()
        }
      })

      // 先放开「关窗即隐藏」的拦截，再停下载、关库，最后销毁托盘
      app.on('before-quit', () => {
        markQuitting()
        tray.destroy()
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

  // 常驻托盘：窗口全关也不退出进程，结束只能走托盘「退出」或系统退出
  app.on('window-all-closed', () => undefined)
}
