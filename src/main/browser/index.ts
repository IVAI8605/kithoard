import { BrowserWindow, WebContentsView, session, shell } from 'electron'
import { CHANNELS } from '@shared/channels'
import { makeError } from '@shared/errors'
import type { BrowserRecentItem, BrowserState } from '@shared/types'
import { log } from '../log'
import { getPlainSetting, setPlainSetting } from '../settings'
import { isHttpUrl, isLoginUrl, normalizeBrowserUrl } from './url'

const RECENT_KEY = 'browser.recent'
const MAX_RECENT = 10

export interface BrowserService {
  /** 打开指定 URL；复用同一个视图 */
  open(raw: unknown): Promise<BrowserState>
  /** 前进/后退/刷新/停止/跳转 */
  navigate(raw: unknown): Promise<BrowserState>
  /** 渲染层占位区域的位置与大小（DIP） */
  setBounds(raw: unknown): { ok: true }
  hide(): { ok: true }
  recent(): BrowserRecentItem[]
  /** 用系统浏览器打开当前或指定 URL */
  external(raw: unknown): Promise<{ ok: true }>
}

export function createBrowserService(deps: {
  notify: (channel: string, payload: unknown) => void
}): BrowserService {
  let view: WebContentsView | null = null
  let owner: BrowserWindow | null = null
  let sessionReady = false
  let state: BrowserState = emptyState()
  /** 最近一次安全提示只保持一轮状态推送，避免永久挂在地址栏 */
  let pendingNotice: string | null = null

  function emit(): void {
    const win = owner
    if (!win || win.isDestroyed()) return
    const payload: BrowserState = {
      ...state,
      notice: pendingNotice ?? state.notice,
      canGoBack: view ? view.webContents.navigationHistory.canGoBack() : false,
      canGoForward: view ? view.webContents.navigationHistory.canGoForward() : false
    }
    state = payload
    deps.notify(CHANNELS.browserState, payload)
  }

  function ensureView(win: BrowserWindow): WebContentsView {
    if (view && owner === win && !view.webContents.isDestroyed()) return view
    if (view && !view.webContents.isDestroyed()) {
      owner?.contentView.removeChildView(view)
    }

    const tempSession = session.fromPartition('kithoard-browser')
    if (!sessionReady) {
      // 临时分区（非 persist:）退出应用即清 Cookie 与缓存；权限一律拒绝
      tempSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
      tempSession.setPermissionCheckHandler(() => false)
      tempSession.on('will-download', (event) => {
        // 页面触发的下载一律不接受，避免把任意文件写进磁盘
        event.preventDefault()
        pendingNotice = '页面下载已拦截'
        emit()
      })
      sessionReady = true
    }

    view = new WebContentsView({
      webPreferences: {
        session: tempSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    view.setBackgroundColor('#12100e')
    owner = win
    win.contentView.addChildView(view)

    const contents = view.webContents
    contents.setWindowOpenHandler(({ url }) => {
      if (isHttpUrl(url)) void shell.openExternal(url)
      pendingNotice = '新窗口已转系统浏览器'
      emit()
      return { action: 'deny' }
    })

    contents.on('will-navigate', (event, url) => {
      if (!isHttpUrl(url)) {
        event.preventDefault()
        pendingNotice = '该协议已拦截'
        emit()
        return
      }
      if (isLoginUrl(url)) {
        event.preventDefault()
        void shell.openExternal(url)
        pendingNotice = '登录页已转系统浏览器'
        emit()
      }
    })

    contents.on('did-start-loading', () => {
      state = { ...state, loading: true, error: null }
      pendingNotice = null
      emit()
    })
    contents.on('did-stop-loading', () => {
      state = { ...state, loading: false }
      emit()
    })
    contents.on('did-navigate', (_event, url) => {
      state = { ...state, url }
      recordRecent(url, contents.getTitle())
      emit()
    })
    contents.on('did-navigate-in-page', (_event, url) => {
      state = { ...state, url }
      emit()
    })
    contents.on('page-title-updated', (_event, title) => {
      state = { ...state, title }
      recordRecent(state.url, title)
      emit()
    })
    contents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
      // -3 是用户主动中止/重定向，不算错误
      if (!isMainFrame || code === -3) return
      state = { ...state, error: `页面加载失败（${description}）`, loading: false }
      log.warn(`browser load failed code=${code} url=${validatedURL}`)
      emit()
    })

    return view
  }

  function recordRecent(url: string, title: string): void {
    if (!isHttpUrl(url) || isLoginUrl(url)) return
    const list = readRecent().filter((item) => item.url !== url)
    list.unshift({ url, title: title || url, visitedAt: Date.now() })
    setPlainSetting(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)))
  }

  async function load(url: string): Promise<BrowserState> {
    if (!isHttpUrl(url)) throw makeError('E_URL_FORBIDDEN', url)
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) throw makeError('E_UNKNOWN', 'no window')
    const target = ensureView(win)
    target.setVisible(true)
    state = { ...emptyState(), url, loading: true }
    emit()
    await target.webContents.loadURL(url)
    return state
  }

  return {
    async open(raw) {
      const url = normalizeBrowserUrl(asRecord(raw).url)
      if (!url) throw makeError('E_INVALID_ARG', 'url')
      return load(url)
    },

    async navigate(raw) {
      const record = asRecord(raw)
      const action = record.action
      if (!view) throw makeError('E_INVALID_ARG', 'view not open')
      const contents = view.webContents
      if (action === 'go') {
        const url = normalizeBrowserUrl(record.url)
        if (!url) throw makeError('E_INVALID_ARG', 'url')
        return load(url)
      }
      if (action === 'back') contents.navigationHistory.goBack()
      else if (action === 'forward') contents.navigationHistory.goForward()
      else if (action === 'reload') contents.reload()
      else if (action === 'stop') contents.stop()
      else throw makeError('E_INVALID_ARG', 'action')
      return state
    },

    setBounds(raw) {
      const record = asRecord(raw)
      const x = Math.round(Number(record.x))
      const y = Math.round(Number(record.y))
      const width = Math.round(Number(record.width))
      const height = Math.round(Number(record.height))
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
        throw makeError('E_INVALID_ARG', 'bounds')
      }
      if (!view) return { ok: true }
      view.setBounds({ x, y, width, height })
      view.setVisible(true)
      return { ok: true }
    },

    hide() {
      view?.setVisible(false)
      return { ok: true }
    },

    recent() {
      return readRecent()
    },

    async external(raw) {
      const url = normalizeBrowserUrl(asRecord(raw).url)
      if (!url) throw makeError('E_URL_FORBIDDEN', 'url')
      await shell.openExternal(url)
      return { ok: true }
    }
  }
}

function emptyState(): BrowserState {
  return {
    url: '',
    title: '',
    canGoBack: false,
    canGoForward: false,
    loading: false,
    notice: null,
    error: null
  }
}

function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
}

function readRecent(): BrowserRecentItem[] {
  const raw = getPlainSetting(RECENT_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (item): item is BrowserRecentItem =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as BrowserRecentItem).url === 'string' &&
          typeof (item as BrowserRecentItem).title === 'string' &&
          typeof (item as BrowserRecentItem).visitedAt === 'number'
      )
      .slice(0, MAX_RECENT)
  } catch {
    return []
  }
}
