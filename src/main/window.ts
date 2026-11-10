import { BrowserWindow, screen, shell } from 'electron'
import path from 'node:path'
import { CHANNELS } from '@shared/channels'
import { getPlainSetting, setPlainSetting } from './settings'

interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

const MIN_WIDTH = 1024
const MIN_HEIGHT = 680

/** 恢复上次窗口位置，但必须落在当前某块屏幕内，避免换显示器后窗口跑到屏幕外 */
function loadBounds(): WindowBounds | null {
  const raw = getPlainSetting('ui.windowBounds')
  if (!raw) return null
  try {
    const parsed = asBounds(JSON.parse(raw))
    if (!parsed) return null
    const visible = screen.getAllDisplays().some(({ workArea }) => {
      return (
        parsed.x < workArea.x + workArea.width &&
        parsed.x + parsed.width > workArea.x &&
        parsed.y < workArea.y + workArea.height &&
        parsed.y + parsed.height > workArea.y
      )
    })
    return visible ? parsed : null
  } catch {
    return null
  }
}

function asBounds(value: unknown): WindowBounds | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const keys: Array<keyof WindowBounds> = ['x', 'y', 'width', 'height']
  if (!keys.every((key) => typeof record[key] === 'number')) return null
  const bounds = record as unknown as WindowBounds
  if (bounds.width < MIN_WIDTH || bounds.height < MIN_HEIGHT) return null
  return bounds
}

function saveBounds(win: BrowserWindow): void {
  try {
    const bounds = win.getBounds()
    setPlainSetting('ui.windowBounds', JSON.stringify(bounds))
  } catch {
    // 保存窗口位置失败不影响退出
  }
}

/** 托盘常驻需要拿到当前窗口：隐藏、唤出、发导航事件都从这里走 */
let mainWindow: BrowserWindow | null = null
/**
 * 「关窗即隐藏」只在正常退出时放开。
 * 托盘点「退出」会先调 markQuitting 再 app.quit，否则 close 事件会被自己拦下来。
 */
let quitting = false

/** 退出流程必须先打标记，否则关窗会被「隐藏到托盘」拦截，进程退不出去 */
export function markQuitting(): void {
  quitting = true
}

export function hasMainWindow(): boolean {
  return mainWindow !== null && !mainWindow.isDestroyed()
}

/** 把主窗口唤到前台；窗口已被销毁时重建（托盘常驻期间一般不会发生） */
export function showMainWindow(): void {
  if (!hasMainWindow()) {
    createMainWindow()
    return
  }
  const win = mainWindow as BrowserWindow
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** 托盘菜单请求跳转页面；窗口还没建好时先建窗，事件由渲染层挂载后自行消费 */
export function navigateMainWindow(target: 'home' | 'settings'): void {
  showMainWindow()
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  win.webContents.send(CHANNELS.appNavigate, target)
}

export function createMainWindow(): BrowserWindow {
  const saved = loadBounds()
  const win = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 820,
    ...(saved ? { x: saved.x, y: saved.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: '#16181c',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win.show())
  win.on('close', (event) => {
    // 常驻托盘：关窗只隐藏，下载与库连接都不断；真正退出时 quitting 已置位
    saveBounds(win)
    if (quitting) return
    event.preventDefault()
    win.hide()
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // 外链一律交给系统浏览器，应用内不允许开新窗或跳走
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))

  mainWindow = win
  return win
}
