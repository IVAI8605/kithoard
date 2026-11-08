import { useEffect, useState } from 'react'
import { MAX_ENQUEUE_ASSETS } from '@shared/channels'
import type { SearchResultItem, SearchableType } from '@shared/types'
import AssetCard from '../components/AssetCard'
import ContextMenu from '../components/ContextMenu'
import PreviewDialog from '../components/PreviewDialog'
import { formatSize } from '../format'
import { useAppStore } from '../store'

interface Props {
  onOpenDetail: (assetId: number) => void
}

const AVAILABLE_TYPES: Array<{ value: SearchableType; label: string }> = [
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' }
]

const LOCKED_TYPES = ['音乐', '音效', '字体', '模板']

interface MenuState {
  item: SearchResultItem
  x: number
  y: number
}

export default function SearchPage({ onOpenDetail }: Props) {
  const keyword = useAppStore((state) => state.keyword)
  const type = useAppStore((state) => state.type)
  const status = useAppStore((state) => state.status)
  const groups = useAppStore((state) => state.groups)
  const error = useAppStore((state) => state.error)
  const sources = useAppStore((state) => state.sources)
  const sourcesLoaded = useAppStore((state) => state.sourcesLoaded)
  const setKeyword = useAppStore((state) => state.setKeyword)
  const setType = useAppStore((state) => state.setType)
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen)
  const runSearch = useAppStore((state) => state.runSearch)
  const loadGroupPage = useAppStore((state) => state.loadGroupPage)
  const recent = useAppStore((state) => state.recent)
  const recentLoaded = useAppStore((state) => state.recentLoaded)
  const loadRecent = useAppStore((state) => state.loadRecent)
  const downloadAssets = useAppStore((state) => state.downloadAssets)
  const favoriteIds = useAppStore((state) => state.favoriteIds)
  const toggleFavorite = useAppStore((state) => state.toggleFavorite)
  const addFavorites = useAppStore((state) => state.addFavorites)

  const [menu, setMenu] = useState<MenuState | null>(null)
  const [preview, setPreview] = useState<SearchResultItem | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<number[]>([])

  // 首页一进来（含刚启动）就把本地记录读出来，用户不必先搜一次才能找回上次看的素材
  useEffect(() => {
    if (status === 'idle') void loadRecent()
  }, [status, loadRecent])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const enabledSources = sources.filter((source) => source.enabled)
  const readySources = enabledSources.filter((source) => source.ready)
  // 多源之后不能再只看 Pixabay：只要有一个启用源就绪，就应该允许搜索
  const needsKey = sourcesLoaded && enabledSources.length > 0 && readySources.length === 0
  const sourceDisabled = sourcesLoaded && enabledSources.length === 0
  const searchDisabled = status === 'loading' || keyword.trim().length === 0 || needsKey

  const copySource = async (item: SearchResultItem): Promise<void> => {
    if (!item.pageUrl) {
      setToast('该素材没有可复制的来源链接')
      return
    }
    const response = await window.api.clipboard.writeText(item.pageUrl)
    setToast(response.ok ? '来源链接已复制' : response.error.message)
  }

  const toggleSelect = (item: SearchResultItem): void => {
    // 上限在界面上先挡一次，用户不用点完 21 个才看到主进程报错
    if (!selectedIds.includes(item.id) && selectedIds.length >= MAX_ENQUEUE_ASSETS) {
      setToast(`一次最多下载 ${MAX_ENQUEUE_ASSETS} 个素材，请分批处理`)
      return
    }
    setSelectedIds((prev) =>
      prev.includes(item.id) ? prev.filter((id) => id !== item.id) : [...prev, item.id]
    )
  }

  const enqueue = async (ids: number[]): Promise<void> => {
    const error = await downloadAssets(ids)
    if (!error) {
      setSelectedIds([])
      setToast(`已加入下载队列（${ids.length} 个）`)
      return
    }
    // 主进程用 detail='confirmLarge' 表示「大文件需确认」，不新增错误码（§6.3 错误码保持稳定）
    if (error.detail === 'confirmLarge') {
      const confirmed = window.confirm('其中有超过 200 MB 的文件，确定继续下载吗？')
      if (!confirmed) return
      const retryError = await downloadAssets(ids, true)
      if (retryError) {
        setToast(retryError.message)
        return
      }
      setSelectedIds([])
      setToast(`已加入下载队列（${ids.length} 个）`)
      return
    }
    setToast(error.message)
  }

  const handleToggleFavorite = async (item: SearchResultItem): Promise<void> => {
    const wasFavorited = favoriteIds.includes(item.id)
    const error = await toggleFavorite(item.id)
    setToast(error ? error.message : wasFavorited ? '已取消收藏' : '已收藏')
  }

  const handleBatchFavorite = async (): Promise<void> => {
    if (selectedIds.length === 0) return
    const error = await addFavorites(selectedIds)
    if (error) {
      setToast(error.message)
      return
    }
    setToast(`已收藏 ${selectedIds.length} 个素材`)
    setSelectedIds([])
  }

  const handleBatchDownload = async (): Promise<void> => {
    if (selectedIds.length === 0) return
    // 预估只用于确认框文案；查不到大小时照常可下载，按「未知」展示，不阻塞流程
    const estimate = await window.api.download.estimate(selectedIds)
    const count = estimate.ok ? estimate.data.count : selectedIds.length
    const sizeText =
      estimate.ok && estimate.data.bytes !== null
        ? `预计 ${formatSize(estimate.data.bytes)}`
        : '预计大小未知'
    // 批量入队一次性确认：避免用户勾了十几个之后才在下载页发现选错
    const confirmed = window.confirm(`确认下载选中的 ${count} 个素材？${sizeText}`)
    if (!confirmed) return
    void enqueue(selectedIds)
  }

  return (
    <div className="page">
      <header className="page__head">
        <h1>搜索素材</h1>
        <p className="page__lead">先在外部素材站找，选中的再下载到本地。</p>
      </header>

      {sourcesLoaded && needsKey ? (
        <section className="notice" aria-label="未配置 API Key">
          <div>
            <p className="notice__title">启用的素材源还不能用</p>
            <p className="notice__text">
              这些来源都需要 API Key。填入 Key 后即可搜索，Key 只保存在本机。
            </p>
          </div>
          <button type="button" className="btn btn--primary" onClick={() => setSettingsOpen(true)}>
            填写 Key
          </button>
        </section>
      ) : null}

      {sourcesLoaded && sourceDisabled ? (
        <section className="notice" aria-label="素材源已停用">
          <div>
            <p className="notice__title">没有启用的素材源</p>
            <p className="notice__text">至少启用一个来源才能搜索。</p>
          </div>
          <button type="button" className="btn" onClick={() => setSettingsOpen(true)}>
            去启用
          </button>
        </section>
      ) : null}

      <form
        className="searchbar"
        onSubmit={(event) => {
          event.preventDefault()
          void runSearch()
        }}
      >
        <input
          type="search"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="输入关键词，例如 mountain"
          aria-label="搜索关键词"
        />
        <button type="submit" className="btn btn--primary" disabled={searchDisabled}>
          搜索
        </button>
      </form>

      <div className="filters" role="group" aria-label="素材类型">
        {AVAILABLE_TYPES.map((option) => (
          <button
            key={option.value}
            type="button"
            className={type === option.value ? 'chip chip--on' : 'chip'}
            aria-pressed={type === option.value}
            onClick={() => setType(option.value)}
          >
            {option.label}
          </button>
        ))}
        {LOCKED_TYPES.map((label) => (
          <button key={label} type="button" className="chip" disabled title="后续版本提供">
            {label}
          </button>
        ))}
      </div>

      {selectedIds.length > 0 ? (
        <div className="bulkbar" role="region" aria-label="批量操作">
          <span>
            已选 {selectedIds.length} / {MAX_ENQUEUE_ASSETS} 个素材
          </span>
          <div className="bulkbar__actions">
            <button type="button" className="btn btn--small" onClick={() => setSelectedIds([])}>
              取消选择
            </button>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => void handleBatchFavorite()}
            >
              收藏所选
            </button>
            <button
              type="button"
              className="btn btn--small btn--primary"
              onClick={() => void handleBatchDownload()}
            >
              下载所选
            </button>
          </div>
        </div>
      ) : null}

      <div className="result-head">
        {status === 'loading' ? <p className="status">正在搜索…</p> : null}
      </div>

      {status === 'loading' ? (
        <div className="grid" aria-hidden="true">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="card card--skeleton">
              <div className="card__thumb" />
              <div className="card__body">
                <div className="skeleton-line" />
                <div className="skeleton-line skeleton-line--short" />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {status === 'ready'
        ? groups.map((group) => (
            <section
              key={group.sourceId}
              className="source-group"
              aria-label={`${group.sourceName} 结果`}
            >
              <div className="source-group__head">
                <h2>{group.sourceName}</h2>
                {group.error ? (
                  <span className="source-group__error">{group.error.message}</span>
                ) : (
                  <span className="source-group__meta">
                    共 {group.totalHits.toLocaleString('zh-CN')} 条 · 第 {group.page} 页
                    {group.rateLimitRemaining !== null
                      ? ` · 本分钟额度剩余 ${group.rateLimitRemaining} 次`
                      : ''}
                  </span>
                )}
              </div>

              {group.error ? (
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => void loadGroupPage(group.sourceId, 1)}
                >
                  重试该来源
                </button>
              ) : group.items.length === 0 ? (
                <p className="muted">该来源没有找到结果。</p>
              ) : (
                <>
                  <div className="grid">
                    {group.items.map((item) => (
                      <AssetCard
                        key={item.id}
                        item={item}
                        onPreview={setPreview}
                        onOpen={onOpenDetail}
                        onMenu={(target, point) => setMenu({ item: target, ...point })}
                        selected={selectedIds.includes(item.id)}
                        onToggleSelect={toggleSelect}
                        onDownload={(target) => void enqueue([target.id])}
                        favorited={favoriteIds.includes(item.id)}
                        onToggleFavorite={(target) => void handleToggleFavorite(target)}
                      />
                    ))}
                  </div>
                  <nav className="pager" aria-label={`${group.sourceName} 分页`}>
                    <button
                      type="button"
                      className="btn"
                      disabled={group.page <= 1}
                      onClick={() => void loadGroupPage(group.sourceId, group.page - 1)}
                    >
                      上一页
                    </button>
                    <span>第 {group.page} 页</span>
                    <button
                      type="button"
                      className="btn"
                      disabled={!group.hasNext}
                      onClick={() => void loadGroupPage(group.sourceId, group.page + 1)}
                    >
                      下一页
                    </button>
                  </nav>
                </>
              )}

              {group.sourceNotice ? (
                <p className="source-group__notice">
                  <a href={group.sourceNotice.url} target="_blank" rel="noreferrer">
                    {group.sourceNotice.text}
                  </a>
                </p>
              ) : null}
            </section>
          ))
        : null}

      {status === 'empty' ? (
        <section className="state">
          <p className="state__title">没有找到相关素材</p>
          <p className="state__text">
            换个关键词，或检查拼写后重试；也可以在「设置」里启用更多素材源。
          </p>
        </section>
      ) : null}

      {status === 'error' ? (
        <section className="state" role="alert">
          <p className="state__title">{error?.message ?? '搜索失败'}</p>
          {error?.detail ? (
            <details className="state__detail">
              <summary>技术细节</summary>
              <code>{error.detail}</code>
            </details>
          ) : null}
          <button type="button" className="btn" onClick={() => void runSearch()}>
            重试
          </button>
        </section>
      ) : null}

      {status === 'idle' ? (
        recent.length > 0 ? (
          <section className="recent" aria-label="最近浏览">
            <div className="recent__head">
              <h2 className="recent__title">最近浏览</h2>
              <p className="recent__note">上次查看过的素材，关掉软件再回来点开还是同一条。</p>
            </div>
            <div className="grid">
              {recent.map((item) => (
                <AssetCard
                  key={item.id}
                  item={item}
                  onPreview={setPreview}
                  onOpen={onOpenDetail}
                  onMenu={(target, point) => setMenu({ item: target, ...point })}
                  selected={selectedIds.includes(item.id)}
                  onToggleSelect={toggleSelect}
                  onDownload={(target) => void enqueue([target.id])}
                />
              ))}
            </div>
          </section>
        ) : (
          <section className="state">
            <p className="state__title">输入关键词开始搜索</p>
            <p className="state__text">
              {recentLoaded ? '当前已启用 ' + enabledSources.map((s) => s.name).join('、') + '，单页 20 条。' : '正在读取本地记录…'}
            </p>
          </section>
        )
      ) : null}

      {menu ? (
        <ContextMenu
          item={menu.item}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onPreview={() => {
            setPreview(menu.item)
            setMenu(null)
          }}
          onDetail={() => {
            onOpenDetail(menu.item.id)
            setMenu(null)
          }}
          onCopy={() => {
            void copySource(menu.item)
            setMenu(null)
          }}
        />
      ) : null}

      {preview ? (
        <PreviewDialog
          item={preview}
          onClose={() => setPreview(null)}
          onDetail={() => {
            const assetId = preview.id
            setPreview(null)
            onOpenDetail(assetId)
          }}
        />
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  )
}
