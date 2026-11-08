import { useCallback, useEffect, useState } from 'react'
import { formatSize } from '../format'
import { useAppStore } from '../store'

/**
 * 设置页（§7.5-3）：并发、保存目录、缓存、源开关与 Key。
 * 所有写操作都走主进程白名单校验，界面只负责收集与回显。
 */
export default function SettingsPage() {
  const sources = useAppStore((state) => state.sources)
  const keyStorage = useAppStore((state) => state.keyStorage)
  const saveApiKey = useAppStore((state) => state.saveApiKey)
  const toggleSource = useAppStore((state) => state.toggleSource)

  const [downloadDir, setDownloadDir] = useState('')
  const [concurrency, setConcurrency] = useState(3)
  const [cacheBytes, setCacheBytes] = useState(0)
  /** 每个源一份输入值，切换源或新增源都不用改结构 */
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({})
  const [toast, setToast] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [dirResult, concurrencyResult, cacheResult] = await Promise.all([
      window.api.settings.get('download.dir'),
      window.api.settings.get('download.concurrency'),
      window.api.settings.get('cache.size')
    ])
    if (dirResult.ok && typeof dirResult.data === 'string') setDownloadDir(dirResult.data)
    if (concurrencyResult.ok && typeof concurrencyResult.data === 'number') {
      setConcurrency(concurrencyResult.data)
    }
    if (cacheResult.ok && typeof cacheResult.data === 'number') setCacheBytes(cacheResult.data)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2400)
    return () => window.clearTimeout(timer)
  }, [toast])

  const changeDir = async (): Promise<void> => {
    const picked = await window.api.settings.pickDir()
    if (!picked.ok) {
      setToast(picked.error.message)
      return
    }
    // 用户取消选择不是错误
    if (!picked.data.path) return
    const result = await window.api.settings.set('download.dir', picked.data.path)
    if (!result.ok) {
      setToast(result.error.message)
      return
    }
    setDownloadDir(picked.data.path)
    setToast('保存目录已更新')
  }

  const saveConcurrency = async (): Promise<void> => {
    setBusy(true)
    const result = await window.api.settings.set('download.concurrency', concurrency)
    setBusy(false)
    setToast(result.ok ? '并发数已保存，新任务会按新值取队' : result.error.message)
  }

  const cleanCacheNow = async (): Promise<void> => {
    setBusy(true)
    const result = await window.api.settings.cleanCache()
    setBusy(false)
    if (!result.ok) {
      setToast(result.error.message)
      return
    }
    setToast(
      result.data.removed > 0
        ? `已清理 ${result.data.removed} 个缓存文件，释放 ${formatSize(result.data.bytes)}`
        : '没有需要清理的缓存'
    )
    void load()
  }

  const submitKey = async (sourceId: string, value: string): Promise<void> => {
    setBusy(true)
    const error = await saveApiKey(sourceId, value)
    setBusy(false)
    if (error) {
      setToast(error.message)
      return
    }
    setKeyInputs({ ...keyInputs, [sourceId]: '' })
    setToast(value ? 'Key 已保存' : 'Key 已清除')
  }

  return (
    <div className="page">
      <header className="page__head">
        <h1>设置</h1>
        <p className="page__lead">下载位置、并发与素材源都在这里调整；所有设置只保存在本机。</p>
      </header>

      <section className="settings-block">
        <h2>下载</h2>
        <div className="settings-row">
          <div>
            <p className="settings-row__label">保存目录</p>
            <p className="settings-row__value">{downloadDir || '加载中…'}</p>
          </div>
          <button type="button" className="btn btn--small" onClick={() => void changeDir()}>
            更改…
          </button>
        </div>

        <div className="settings-row">
          <div>
            <p className="settings-row__label">同时下载数量</p>
            <p className="settings-row__value">
              当前 {concurrency} 个，可选 1–5；调小不打断正在下载的任务。
            </p>
          </div>
          <div className="settings-inline">
            <input
              type="number"
              min={1}
              max={5}
              value={concurrency}
              aria-label="并发数"
              onChange={(event) => setConcurrency(Number(event.target.value))}
            />
            <button
              type="button"
              className="btn btn--small"
              disabled={busy || concurrency < 1 || concurrency > 5}
              onClick={() => void saveConcurrency()}
            >
              保存
            </button>
          </div>
        </div>
      </section>

      <section className="settings-block">
        <h2>缓存</h2>
        <div className="settings-row">
          <div>
            <p className="settings-row__label">缩略图与接口缓存</p>
            <p className="settings-row__value">
              当前占用 {formatSize(cacheBytes)}；超过 7 天的缓存会在启动时自动清理，不影响未完成的下载。
            </p>
          </div>
          <button
            type="button"
            className="btn btn--small"
            disabled={busy}
            onClick={() => void cleanCacheNow()}
          >
            立即清理
          </button>
        </div>
      </section>

      <section className="settings-block">
        <h2>素材源</h2>
        {sources.map((source) => (
          <div key={source.id} className="settings-source">
            <div className="settings-row">
              <div>
                <p className="settings-row__label">{source.name}</p>
                <p className="settings-row__value">
                  {source.requiresApiKey
                    ? `Key 状态：${source.hasApiKey ? '已配置' : '未配置'}。Key 只保存在本机，备份不会包含它。`
                    : '该来源无需 Key。'}
                </p>
                {keyStorage === 'plaintext' && source.requiresApiKey ? (
                  <p className="dialog__warn">
                    当前系统不支持安全加密，Key 会以明文保存在本机数据库，请注意电脑本身的安全。
                  </p>
                ) : null}
              </div>
              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={source.enabled}
                  disabled={busy}
                  onChange={(event) => {
                    setBusy(true)
                    void toggleSource(source.id, event.target.checked).then((error) => {
                      setBusy(false)
                      if (error) setToast(error.message)
                    })
                  }}
                />
                <span>启用</span>
              </label>
            </div>

            {source.requiresApiKey ? (
              <>
                <form
                  className="dialog__form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void submitKey(source.id, keyInputs[source.id] ?? '')
                  }}
                >
                  <input
                    type="password"
                    value={keyInputs[source.id] ?? ''}
                    onChange={(event) =>
                      setKeyInputs({ ...keyInputs, [source.id]: event.target.value })
                    }
                    placeholder={
                      source.hasApiKey ? '填入新 Key 可替换' : `粘贴 ${source.name} API Key`
                    }
                    aria-label={`${source.name} API Key`}
                  />
                  <button
                    type="submit"
                    className="btn btn--primary"
                    disabled={busy || !(keyInputs[source.id] ?? '').trim()}
                  >
                    保存 Key
                  </button>
                </form>
                {source.hasApiKey ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--small"
                    disabled={busy}
                    onClick={() => void submitKey(source.id, '')}
                  >
                    清除已保存的 Key
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        ))}
      </section>

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  )
}
