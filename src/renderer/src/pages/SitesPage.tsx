import { useEffect, useRef, useState } from 'react'
import type { BrowserRecentItem, BrowserState } from '@shared/types'
import { formatDateTime } from '../format'

/**
 * 受限站内浏览（§7.8-1/2）：页面只负责地址栏与占位区域，
 * 真正的 WebContentsView 由主进程创建并按这里上报的矩形摆放。
 */
export default function SitesPage() {
  const [address, setAddress] = useState('')
  const [state, setState] = useState<BrowserState | null>(null)
  const [recent, setRecent] = useState<BrowserRecentItem[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const holderRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void window.api.browser.recent().then((result) => {
      if (result.ok) setRecent(result.data)
    })
    const off = window.api.browser.onState((next) => {
      setState(next)
      if (next.notice) setToast(next.notice)
      if (next.error) setToast(next.error)
    })
    // 离开页面必须隐藏视图，否则浏览内容会盖在别的页面上
    return () => {
      off()
      void window.api.browser.hide()
    }
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2600)
    return () => window.clearTimeout(timer)
  }, [toast])

  // 占位区域的位置变化（窗口缩放、列表增减）都要同步给主进程，否则视图会错位
  useEffect(() => {
    const el = holderRef.current
    if (!el) return
    const report = (): void => {
      const rect = el.getBoundingClientRect()
      if (rect.width < 10 || rect.height < 10) return
      void window.api.browser.setBounds({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      })
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [])

  useEffect(() => {
    if (state?.url) setAddress(state.url)
  }, [state?.url])

  const go = async (url?: string): Promise<void> => {
    const value = (url ?? address).trim()
    if (!value) return
    const result = await window.api.browser.open(value)
    if (!result.ok) {
      setToast(result.error.message)
      return
    }
    setState(result.data)
    setAddress(result.data.url || value)
    void window.api.browser.recent().then((next) => {
      if (next.ok) setRecent(next.data)
    })
  }

  const navigate = async (action: 'back' | 'forward' | 'reload' | 'stop'): Promise<void> => {
    const result = await window.api.browser.navigate(action)
    if (!result.ok) {
      setToast(result.error.message)
      return
    }
    setState(result.data)
  }

  const copyLink = async (): Promise<void> => {
    const url = state?.url || address
    if (!url) return
    const result = await window.api.clipboard.writeText(url)
    setToast(result.ok ? '链接已复制' : result.error.message)
  }

  const openExternal = async (): Promise<void> => {
    const url = state?.url || address
    if (!url) return
    const result = await window.api.browser.external(url)
    setToast(result.ok ? '已用系统浏览器打开' : result.error.message)
  }

  return (
    <div className="page page--sites">
      <header className="page__head">
        <h1>网站导航</h1>
        <p className="page__lead">
          站内浏览只用于找素材；登录、付费、新窗口与外部协议都会转交系统浏览器，页面下载一律拦截。
        </p>
      </header>

      <form
        className="sites-bar"
        onSubmit={(event) => {
          event.preventDefault()
          void go()
        }}
      >
        <button
          type="button"
          className="btn btn--small"
          disabled={!state?.canGoBack}
          onClick={() => void navigate('back')}
        >
          后退
        </button>
        <button
          type="button"
          className="btn btn--small"
          disabled={!state?.canGoForward}
          onClick={() => void navigate('forward')}
        >
          前进
        </button>
        <button
          type="button"
          className="btn btn--small"
          onClick={() => void navigate(state?.loading ? 'stop' : 'reload')}
        >
          {state?.loading ? '停止' : '刷新'}
        </button>
        <input
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="输入网址，例如 https://pixabay.com"
          aria-label="网址"
        />
        <button type="submit" className="btn btn--primary btn--small">
          打开
        </button>
      </form>

      <div className="sites-actions">
        <button type="button" className="btn btn--small" onClick={() => void copyLink()}>
          复制链接
        </button>
        <button type="button" className="btn btn--small" onClick={() => void openExternal()}>
          系统浏览器打开
        </button>
        {state?.loading ? <span className="sites-status">正在加载…</span> : null}
      </div>

      <div className="sites-holder" ref={holderRef} aria-label="浏览区域">
        {!state?.url ? (
          <p className="sites-holder__hint">在上方输入网址开始浏览，或从下面的最近访问里选一个。</p>
        ) : null}
      </div>

      <section className="sites-recent">
        <h2>最近访问</h2>
        {recent.length === 0 ? (
          <p className="sites-recent__empty">还没有访问记录。</p>
        ) : (
          <ul className="sites-recent__list">
            {recent.map((item) => (
              <li key={item.url}>
                <button
                  type="button"
                  className="sites-recent__item"
                  onClick={() => {
                    setAddress(item.url)
                    void go(item.url)
                  }}
                >
                  <span className="sites-recent__title">{item.title || item.url}</span>
                  <span className="sites-recent__meta">
                    {item.url} · {formatDateTime(item.visitedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  )
}
