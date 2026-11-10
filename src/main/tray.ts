import fs from 'node:fs'
import path from 'node:path'
import { Menu, Tray, nativeImage } from 'electron'
import { log } from './log'
import { buildTrayMenu } from './tray-menu'

/** 托盘图标随包到 resources/icons；开发模式回落到项目目录，与 FFmpeg 的解析口径一致 */
function trayIconPath(): string {
  const resourcesPath = process.resourcesPath
  if (resourcesPath) {
    const packed = path.join(resourcesPath, 'icons', 'tray.png')
    if (fs.existsSync(packed)) return packed
  }
  return path.join(process.cwd(), 'resources', 'icons', 'tray.png')
}

export interface TrayController {
  destroy(): void
}

/**
 * 系统托盘：双击打开主页面，右键出菜单。
 * 菜单里三项动作都由调用方注入，本模块只负责把事件接上去。
 */
export function createTray(deps: {
  onOpenHome: () => void
  onOpenSettings: () => void
  onQuit: () => void
}): TrayController {
  const tray = new Tray(nativeImage.createFromPath(trayIconPath()))
  tray.setToolTip('Kithoard 栖材坞')
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenu(deps)))
  // Windows 上左键双击是打开主页面最常用的手势；右键由 Electron 自动弹上下文菜单
  tray.on('double-click', () => deps.onOpenHome())
  log.info('tray created')
  return {
    destroy() {
      tray.destroy()
    }
  }
}
