import { useCallback, useEffect, useState } from 'react'
import type { AssetType, LocalFileItem } from '@shared/types'
import { formatDateTime, formatSize, typeLabel } from '../format'

/** 与主进程默认值一致；一页 50 条足够覆盖常见素材库，翻页成本也低 */
const PAGE_SIZE = 50

const TYPE_FILTERS: Array<{ value: AssetType | 'all'; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' }
]

type LoadStatus = 'loading' | 'ready' | 'empty' | 'error'

export default function LibraryPage() {
  const [items, setItems] = useState<LocalFileItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [type, setType] = useState<AssetType | 'all'>('all')
  const [draft, setDraft] = useState('')
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [errorText, setErrorText] = useState('')
  const [toast, setToast] = useState<string | null>(null)

  // 筛选条件作为依赖：改类型或关键词就回第一页，避免停在超出范围的页码上
  const load = useCallback(
    async (targetPage: number) => {
      setStatus('loading')
      const result = await window.api.library.list({
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
    },
    [type, keyword]
  )

  useEffect(() => {
    void load(1)
  }, [load])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2400)
    return () => window.clearTimeout(timer)
  }, [toast])

  const act = async (
    action: () => Promise<{ ok: true } | { ok: false; error: { message: string } }>,
    okText: string
  ): Promise<void> => {
    const result = await action()
    setToast(result.ok ? okText : result.error.message)
  }

  const applySearch = (): void => {
    const next = draft.trim()
    // 关键词没变化时 effect 不会重跑，这里手动刷新一次
    if (next === keyword) void load(1)
    else setKeyword(next)
  }

  const clearFilters = (): void => {
    setDraft('')
    setKeyword('')
    setType('all')
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const missingCount = items.filter((item) => item.status === 'missing').length
  const filtered = keyword !== '' || type !== 'all'

  return (
    <div className="page">
      <header className="page__head">
        <h1>本地素材</h1>
        <p className="page__lead">
          下载完成的素材会登记在这里。磁盘上已被删除的文件标为「文件缺失」，记录保留，方便你找回或重新下载。
        </p>
      </header>

      <div className="searchbar">
        <input
          type="search"
          value={draft}
          placeholder="按文件名或素材标题筛选"
          aria-label="筛选本地素材"
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

      {status === 'loading' ? <p className="status">正在读取本地素材…</p> : null}

      {status === 'error' ? (
        <section className="state">
          <p className="state__title">读取本地素材失败</p>
          <p className="state__text">{errorText}</p>
          <button type="button" className="btn btn--small" onClick={() => void load(page)}>
            重试
          </button>
        </section>
      ) : null}

      {status === 'empty' ? (
        <section className="state">
          <p className="state__title">{filtered ? '没有符合条件的素材' : '本地素材还是空的'}</p>
          <p className="state__text">
            {filtered
              ? '换个关键词或类型再试，也可以清空筛选看全部。'
              : '去首页搜索素材并下载，完成后就会出现在这里。'}
          </p>
          {filtered ? (
            <button type="button" className="btn btn--small" onClick={clearFilters}>
              清空筛选
            </button>
          ) : null}
        </section>
      ) : null}

      {status === 'ready' ? (
        <>
          <p className="dl-summary">
            <span>共 {total} 个文件</span>
            {missingCount > 0 ? (
              <span className="dl-summary__warn">本页 {missingCount} 个文件缺失</span>
            ) : null}
          </p>
          <ul className="dl-list">
            {items.map((item) => {
              const missing = item.status === 'missing'
              return (
                <li key={item.id} className={missing ? 'dl-item dl-item--missing' : 'dl-item'}>
                  <div className="dl-item__main">
                    <button
                      type="button"
                      className="dl-item__name"
                      disabled={missing}
                      title={missing ? '文件已不在磁盘上' : '用系统默认程序打开'}
                      onClick={() => void act(() => window.api.library.open(item.id), '已用默认程序打开')}
                    >
                      {item.fileName}
                    </button>
                    <p className="dl-item__meta">
                      <span className={`dl-state dl-state--${missing ? 'failed' : 'done'}`}>
                        {missing ? '文件缺失' : '可用'}
                      </span>
                      <span>{item.type ? typeLabel(item.type) : '类型未知'}</span>
                      <span>{formatSize(item.sizeBytes)}</span>
                      <span>{formatDateTime(item.updatedAt)}</span>
                      {item.title ? <span>{item.title}</span> : null}
                    </p>
                    <p className="dl-item__sub">{item.path}</p>
                  </div>
                  <div className="dl-item__actions">
                    <button
                      type="button"
                      className="btn btn--small"
                      disabled={missing}
                      onClick={() => void act(() => window.api.library.reveal(item.id), '已在文件夹中定位')}
                    >
                      打开位置
                    </button>
                    <button
                      type="button"
                      className="btn btn--small btn--ghost"
                      onClick={() => void act(() => window.api.library.copyPath(item.id), '路径已复制')}
                    >
                      复制路径
                    </button>
                  </div>
                </li>
              )
            })}
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
