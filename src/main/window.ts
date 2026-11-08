import { BrowserWindow, screen, shell } from 'electron'
import path from 'node:path'
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
  win.on('close', () => saveBounds(win))

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

  return win
}
