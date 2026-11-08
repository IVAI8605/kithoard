import { useCallback, useEffect, useState } from 'react'
import type { ClearScope } from '@shared/types'
import { formatSize } from '../format'
import { useAppStore } from '../store'

const CLEAR_LABELS: Record<ClearScope, string> = {
  favorites: '收藏夹',
  downloads: '下载历史',
  settings: '个人设置（含已保存的 API Key）',
  all: '全部数据（收藏夹 + 下载历史 + 个人设置）'
}

/**
 * 设置页（§7.5-3）：并发、保存目录、缓存、源开关与 Key。
 * 所有写操作都走主进程白名单校验，界面只负责收集与回显。
 */
export default function SettingsPage() {
  const sources = useAppStore((state) => state.sources)
  const keyStorage = useAppStore((state) => state.keyStorage)
  const saveApiKey = useAppStore((state) => state.saveApiKey)
  const toggleSource = useAppStore((state) => state.toggleSource)
  const loadSources = useAppStore((state) => state.loadSources)
  const loadFavoriteIds = useAppStore((state) => state.loadFavoriteIds)
  const loadDownloads = useAppStore((state) => state.loadDownloads)
  const loadRecent = useAppStore((state) => state.loadRecent)

  const [downloadDir, setDownloadDir] = useState('')
  const [concurrency, setConcurrency] = useState(3)
  const [cacheBytes, setCacheBytes] = useState(0)
  /** 每个源一份输入值，切换源或新增源都不用改结构 */
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({})
  const [clearScope, setClearScope] = useState<ClearScope>('favorites')
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

  const exportBackupNow = async (): Promise<void> => {
    setBusy(true)
    const result = await window.api.settings.exportBackup()
    setBusy(false)
    if (!result.ok) {
      setToast(result.error.message)
      return
    }
    // 用户取消保存对话框不是失败，静默返回
    if (!result.data.path) return
    const { assets, favorites } = result.data.counts
    setToast(`已导出备份：${assets} 条素材、${favorites} 条收藏（不含素材文件与 Key）`)
  }

  const importBackupNow = async (): Promise<void> => {
    const confirmed = window.confirm(
      '导入会把备份里的素材、收藏与下载记录合并到当前数据，不会删除现有内容。继续吗？'
    )
    if (!confirmed) return

    setBusy(true)
    const result = await window.api.settings.importBackup()
    setBusy(false)
    if (!result.ok) {
      setToast(result.error.message)
      return
    }
    if (!result.data.summary) return

    const summary = result.data.summary
    setToast(
      `导入完成：新增素材 ${summary.addedAssets}、收藏 ${summary.addedFavorites}、` +
        `下载记录 ${summary.addedDownloads}、路径缺失 ${summary.missingPaths}`
    )
    // 导入可能改动收藏、下载历史、最近记录与设置，整页数据重拉一次，避免界面停在旧值
    await Promise.all([load(), loadSources(), loadFavoriteIds(), loadDownloads(), loadRecent()])
  }

  const clearDataNow = async (): Promise<void> => {
    const withKeys = clearScope === 'settings' || clearScope === 'all'
    const confirmed = window.confirm(
      `确定清空${CLEAR_LABELS[clearScope]}吗？此操作不可撤销。` +
        (withKeys ? '\n\n个人设置里包含已保存的 API Key，清空后需要重新填写。' : '') +
        '\n\n已下载的素材文件不会被删除，本地素材记录也会保留。'
    )
    if (!confirmed) return

    setBusy(true)
    const result = await window.api.settings.clearData(clearScope)
    setBusy(false)
    if (!result.ok) {
      setToast(result.error.message)
      return
    }
    const { favorites, downloads, settings } = result.data
    setToast(
      `已清空：收藏 ${favorites} 条、下载记录 ${downloads} 条、设置 ${settings} 项；素材文件保留`
    )
    await Promise.all([load(), loadSources(), loadFavoriteIds(), loadDownloads(), loadRecent()])
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
        <h2>备份与恢复</h2>
        <div className="settings-row">
          <div>
            <p className="settings-row__label">数据备份</p>
            <p className="settings-row__value">
              备份只含素材信息、收藏、下载记录与偏好设置，不含下载的素材文件，也不含 API Key。
              换电脑时把备份文件拷过去导入即可，导入不会删除现有数据。
            </p>
          </div>
          <div className="settings-inline">
            <button
              type="button"
              className="btn btn--small"
              disabled={busy}
              onClick={() => void exportBackupNow()}
            >
              导出…
            </button>
            <button
              type="button"
              className="btn btn--small"
              disabled={busy}
              onClick={() => void importBackupNow()}
            >
              导入…
            </button>
          </div>
        </div>
      </section>

      <section className="settings-block">
        <h2>清空数据</h2>
        <div className="settings-row">
          <div>
            <p className="settings-row__label">按范围清空</p>
            <p className="settings-row__value">
              只删除应用内的记录，不会删除已下载的素材文件；本地素材页里的文件记录会保留。
              清空后无法撤销，建议先导出一份备份。
            </p>
          </div>
          <div className="settings-inline">
            <select
              value={clearScope}
              aria-label="清空范围"
              disabled={busy}
              onChange={(event) => setClearScope(event.target.value as ClearScope)}
            >
              <option value="favorites">仅收藏夹</option>
              <option value="downloads">仅下载历史</option>
              <option value="settings">仅个人设置</option>
              <option value="all">全部（收藏 + 下载 + 设置）</option>
            </select>
            <button
              type="button"
              className="btn btn--small"
              disabled={busy}
              onClick={() => void clearDataNow()}
            >
              清空…
            </button>
          </div>
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
