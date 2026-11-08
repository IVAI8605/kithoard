import { useCallback, useEffect, useState } from 'react'
import type { AssetType, FavoritePage } from '@shared/types'
import { formatDateTime, typeLabel } from '../format'
import { useAppStore } from '../store'

const PAGE_SIZE = 50

const TYPE_FILTERS: Array<{ value: AssetType | 'all'; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' }
]

type LoadStatus = 'loading' | 'ready' | 'empty' | 'error'

interface Props {
  onOpenDetail: (assetId: number) => void
}

export default function FavoritesPage({ onOpenDetail }: Props) {
  const removeFavorites = useAppStore((state) => state.removeFavorites)
  const favoriteIds = useAppStore((state) => state.favoriteIds)
  const [items, setItems] = useState<FavoritePage['items']>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [type, setType] = useState<AssetType | 'all'>('all')
  const [draft, setDraft] = useState('')
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [errorText, setErrorText] = useState('')
  const [selected, setSelected] = useState<number[]>([])
  const [toast, setToast] = useState<string | null>(null)

  const load = useCallback(
    async (targetPage: number) => {
      setStatus('loading')
      const result = await window.api.favorite.list({
        ...(type === 'all' ? {} : { type }),
        ...(keyword ? { keyword } : {}),
        page: targetPage,
        pageSize: PAGE_SIZE
      })
      if (!result.ok) {
        setItems([])
        setTotal(0)
        setErrorText(result.error.message)
        setStatus('error')
        return
      }
      setItems(result.data.items)
      setTotal(result.data.total)
      setPage(result.data.page)
      setStatus(result.data.items.length === 0 ? 'empty' : 'ready')
      setSelected([])
    },
    [type, keyword]
  )

  // favoriteIds 变化说明别处收藏/取消了，列表跟着刷新，避免两个页面状态打架
  useEffect(() => {
    void load(1)
  }, [load, favoriteIds])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2400)
    return () => window.clearTimeout(timer)
  }, [toast])

  const applySearch = (): void => {
    const next = draft.trim()
    if (next === keyword) void load(1)
    else setKeyword(next)
  }

  const toggleOne = (assetId: number): void => {
    setSelected((prev) =>
      prev.includes(assetId) ? prev.filter((id) => id !== assetId) : [...prev, assetId]
    )
  }

  const selectable = items.map((item) => item.assetId)
  const allSelected = selectable.length > 0 && selectable.every((id) => selected.includes(id))
  const toggleAll = (): void => {
    setSelected(allSelected ? [] : selectable)
  }

  const removeSelected = async (assetIds: number[]): Promise<void> => {
    if (assetIds.length === 0) return
    const result = await removeFavorites(assetIds)
    if (result) {
      setToast(result.message)
      return
    }
    setToast(assetIds.length === 1 ? '已取消收藏' : `已取消收藏 ${assetIds.length} 个素材`)
    setSelected([])
    void load(page)
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const filtered = keyword !== '' || type !== 'all'

  return (
    <div className="page">
      <header className="page__head">
        <h1>收藏夹</h1>
        <p className="page__lead">
          收藏的是素材信息，不占磁盘空间。下载完成后可在「本地素材」找到文件。
        </p>
      </header>

      <div className="searchbar">
        <input
          type="search"
          value={draft}
          placeholder="按素材标题筛选"
          aria-label="筛选收藏"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') applySearch()
          }}
        />
        <button type="button" className="btn btn--primary" onClick={applySearch}>
          筛选
        </button>
        <button type="button" className="btn" onClick={() => void load(page)}>
          刷新
        </button>
      </div>

      <div className="filters" role="group" aria-label="素材类型">
        {TYPE_FILTERS.map((option) => (
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
      </div>

      {status === 'loading' ? <p className="status">正在读取收藏…</p> : null}

      {status === 'error' ? (
        <section className="state">
          <p className="state__title">读取收藏失败</p>
          <p className="state__text">{errorText}</p>
          <button type="button" className="btn btn--small" onClick={() => void load(page)}>
            重试
          </button>
        </section>
      ) : null}

      {status === 'empty' ? (
        <section className="state">
          <p className="state__title">{filtered ? '没有符合条件的收藏' : '收藏夹还是空的'}</p>
          <p className="state__text">
            {filtered
              ? '换个关键词或类型再试，也可以清空筛选看全部。'
              : '去首页搜索素材，点卡片上的「收藏」就会出现在这里。'}
          </p>
          {filtered ? (
            <button
              type="button"
              className="btn btn--small"
              onClick={() => {
                setDraft('')
                setKeyword('')
                setType('all')
              }}
            >
              清空筛选
            </button>
          ) : null}
        </section>
      ) : null}

      {status === 'ready' ? (
        <>
          <p className="dl-summary">
            <span>共 {total} 条收藏</span>
          </p>

          <div className="bulk-bar">
            <label className="bulk-bar__check">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              <span>全选本页</span>
            </label>
            <span className="bulk-bar__count">已选 {selected.length} 个</span>
            <button
              type="button"
              className="btn btn--small btn--danger"
              disabled={selected.length === 0}
              onClick={() => void removeSelected(selected)}
            >
              取消收藏
            </button>
            {selected.length > 0 ? (
              <button
                type="button"
                className="btn btn--small btn--ghost"
                onClick={() => setSelected([])}
              >
                取消选择
              </button>
            ) : null}
          </div>

          <ul className="dl-list">
            {items.map((item) => (
              <li key={item.id} className="dl-item">
                <input
                  type="checkbox"
                  className="dl-item__check"
                  checked={selected.includes(item.assetId)}
                  aria-label={`选择 ${item.title ?? item.assetId}`}
                  onChange={() => toggleOne(item.assetId)}
                />
                <div className="dl-item__main">
                  <button
                    type="button"
                    className="dl-item__name"
                    onClick={() => onOpenDetail(item.assetId)}
                  >
                    {item.title ?? '素材已不可用'}
                  </button>
                  <p className="dl-item__meta">
                    <span className="dl-state dl-state--done">已收藏</span>
                    <span>{item.type ? typeLabel(item.type) : '类型未知'}</span>
                    <span>{item.sourceId ?? '来源未知'}</span>
                    <span>{formatDateTime(item.createdAt)}</span>
                  </p>
                </div>
                <div className="dl-item__actions">
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() => onOpenDetail(item.assetId)}
                  >
                    查看详情
                  </button>
                  <button
                    type="button"
                    className="btn btn--small btn--ghost"
                    onClick={() => void removeSelected([item.assetId])}
                  >
                    取消收藏
                  </button>
                </div>
              </li>
            ))}
          </ul>

          {totalPages > 1 ? (
            <div className="pager">
              <button
                type="button"
                className="btn btn--small"
                disabled={page <= 1}
                onClick={() => void load(page - 1)}
              >
                上一页
              </button>
              <span>
                第 {page} / {totalPages} 页
              </span>
              <button
                type="button"
                className="btn btn--small"
                disabled={page >= totalPages}
                onClick={() => void load(page + 1)}
              >
                下一页
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  )
}
