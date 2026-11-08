import { useEffect, useState } from 'react'
import type { SearchResultItem, SearchableType } from '@shared/types'
import AssetCard from '../components/AssetCard'
import ContextMenu from '../components/ContextMenu'
import PreviewDialog from '../components/PreviewDialog'
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
  const page = useAppStore((state) => state.page)
  const status = useAppStore((state) => state.status)
  const items = useAppStore((state) => state.items)
  const result = useAppStore((state) => state.result)
  const error = useAppStore((state) => state.error)
  const sources = useAppStore((state) => state.sources)
  const sourcesLoaded = useAppStore((state) => state.sourcesLoaded)
  const setKeyword = useAppStore((state) => state.setKeyword)
  const setType = useAppStore((state) => state.setType)
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen)
  const runSearch = useAppStore((state) => state.runSearch)

  const [menu, setMenu] = useState<MenuState | null>(null)
  const [preview, setPreview] = useState<SearchResultItem | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const pixabay = sources.find((source) => source.id === 'pixabay')
  const needsKey = Boolean(pixabay && pixabay.requiresApiKey && !pixabay.hasApiKey)
  const sourceDisabled = Boolean(pixabay && !pixabay.enabled)
  const searchDisabled = status === 'loading' || keyword.trim().length === 0 || needsKey

  const copySource = async (item: SearchResultItem): Promise<void> => {
    if (!item.pageUrl) {
      setToast('该素材没有可复制的来源链接')
      return
    }
    const response = await window.api.clipboard.writeText(item.pageUrl)
    setToast(response.ok ? '来源链接已复制' : response.error.message)
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
            <p className="notice__title">还没有配置 Pixabay API Key</p>
            <p className="notice__text">填入 Key 后即可搜索。Key 只保存在本机，不会上传。</p>
          </div>
          <button type="button" className="btn btn--primary" onClick={() => setSettingsOpen(true)}>
            填写 Key
          </button>
        </section>
      ) : null}

      {sourcesLoaded && sourceDisabled ? (
        <section className="notice" aria-label="素材源已停用">
          <div>
            <p className="notice__title">Pixabay 已被停用</p>
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
          void runSearch(1)
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

      <div className="result-head">
        {status === 'ready' && result ? (
          <p className="result-meta">
            <span>共 {result.totalHits.toLocaleString('zh-CN')} 条结果</span>
            <span>第 {result.page} 页</span>
            {result.rateLimitRemaining !== null ? (
              <span>本分钟额度剩余 {result.rateLimitRemaining} 次</span>
            ) : null}
          </p>
        ) : null}
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

      {status === 'ready' ? (
        <div className="grid">
          {items.map((item) => (
            <AssetCard
              key={item.id}
              item={item}
              onPreview={setPreview}
              onOpen={onOpenDetail}
              onMenu={(target, point) => setMenu({ item: target, ...point })}
            />
          ))}
        </div>
      ) : null}

      {status === 'empty' ? (
        <section className="state">
          <p className="state__title">没有找到相关素材</p>
          <p className="state__text">换个关键词，或检查拼写后重试。</p>
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
          <button type="button" className="btn" onClick={() => void runSearch(page)}>
            重试
          </button>
        </section>
      ) : null}

      {status === 'ready' && result ? (
        <nav className="pager" aria-label="分页">
          <button
            type="button"
            className="btn"
            disabled={result.page <= 1}
            onClick={() => void runSearch(result.page - 1)}
          >
            上一页
          </button>
          <span>第 {result.page} 页</span>
          <button
            type="button"
            className="btn"
            disabled={!result.hasNext}
            onClick={() => void runSearch(result.page + 1)}
          >
            下一页
          </button>
        </nav>
      ) : null}

      {status === 'idle' ? (
        <section className="state">
          <p className="state__title">输入关键词开始搜索</p>
          <p className="state__text">当前支持 Pixabay 的图片与视频，单页 20 条。</p>
        </section>
      ) : null}

      {result?.sourceNotice ? (
        <p className="powered">
          <a href={result.sourceNotice.url} target="_blank" rel="noreferrer">
            {result.sourceNotice.text}
          </a>
        </p>
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
