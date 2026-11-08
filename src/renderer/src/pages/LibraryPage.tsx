import { useCallback, useEffect, useState } from 'react'
import type { AssetType, LocalFileItem, LocalFileProps } from '@shared/types'
import FilePropsDialog from '../components/FilePropsDialog'
import ImageProcessDialog from '../components/ImageProcessDialog'
import { formatDateTime, formatSize, typeLabel } from '../format'

/** 与主进程默认值一致；一页 50 条足够覆盖常见素材库，翻页成本也低 */
const PAGE_SIZE = 50

/** 图片处理只接这几种扩展名，与主进程 media service 的白名单一致 */
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.bmp'])

function isImageFile(fileName: string): boolean {
  const index = fileName.lastIndexOf('.')
  return index > 0 && IMAGE_EXTS.has(fileName.slice(index).toLowerCase())
}

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
  const [selected, setSelected] = useState<number[]>([])
  /** 重命名用行内输入，避免再弹一层窗口；prompt 在 Electron 里不可用 */
  const [renaming, setRenaming] = useState<{ id: number; value: string } | null>(null)
  const [propsItem, setPropsItem] = useState<LocalFileProps | null>(null)
  /** 非空时打开图片处理面板；存 id 而不是整条记录，避免处理期间列表刷新后引用过期 */
  const [mediaTargets, setMediaTargets] = useState<number[] | null>(null)

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
      // 列表已变，跨页保留旧选中只会让批量操作误伤，直接清空
      setSelected([])
      setRenaming(null)
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

  const toggleOne = (id: number): void => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  }

  const selectable = items.filter((item) => item.status === 'present')
  const allSelected = selectable.length > 0 && selectable.every((item) => selected.includes(item.id))
  const toggleAll = (): void => {
    setSelected(allSelected ? [] : selectable.map((item) => item.id))
  }

  const moveSelected = async (): Promise<void> => {
    if (selected.length === 0) return
    const picked = await window.api.library.pickDir()
    if (!picked.ok) {
      setToast(picked.error.message)
      return
    }
    // 用户取消选择目录不是错误，什么都不做
    if (!picked.data.path) return
    const result = await window.api.library.move(selected, picked.data.path)
    if (!result.ok) {
      setToast(result.error.message)
      return
    }
    const failed = result.data.failed.length
    const moved = selected.length - failed
    setToast(failed > 0 ? `已移动 ${moved} 个，${failed} 个失败` : `已移动 ${moved} 个文件`)
    void load(page)
  }

  const trashItems = async (ids: number[]): Promise<void> => {
    if (ids.length === 0) return
    const confirmed = window.confirm(
      `将 ${ids.length} 个文件移入系统回收站？之后随时可以从回收站还原。`
    )
    if (!confirmed) return
    const result = await window.api.library.trash(ids)
    if (!result.ok) {
      setToast(result.error.message)
      return
    }
    const failed = result.data.failed.length
    setToast(failed > 0 ? `已删除 ${ids.length - failed} 个，${failed} 个失败` : '已移入系统回收站')
    void load(page)
  }

  const submitRename = async (): Promise<void> => {
    if (!renaming) return
    const result = await window.api.library.rename(renaming.id, renaming.value)
    if (!result.ok) {
      // 保留输入框让用户就地修改，不用重新点一次重命名
      setToast(result.error.message)
      return
    }
    setRenaming(null)
    setToast('已重命名')
    void load(page)
  }

  const openProps = async (id: number): Promise<void> => {
    const result = await window.api.library.props(id)
    if (!result.ok) {
      setToast(result.error.message)
      return
    }
    setPropsItem(result.data)
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const missingCount = items.filter((item) => item.status === 'missing').length
  const filtered = keyword !== '' || type !== 'all'
  // 批量处理要求整批都是图片；混入视频时按钮置灰，避免主进程整批拒绝
  const selectedItems = items.filter((item) => selected.includes(item.id))
  const mediaEligible =
    selectedItems.length > 0 && selectedItems.every((item) => isImageFile(item.fileName))

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

          <div className="bulk-bar">
            <label className="bulk-bar__check">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              <span>全选本页</span>
            </label>
            <span className="bulk-bar__count">已选 {selected.length} 个</span>
            <button
              type="button"
              className="btn btn--small"
              disabled={!mediaEligible}
              title={mediaEligible ? '格式转换、压缩或编辑' : '只支持图片，且选中项必须全部是图片'}
              onClick={() => setMediaTargets(selected)}
            >
              图片处理…
            </button>
            <button
              type="button"
              className="btn btn--small"
              disabled={selected.length === 0}
              onClick={() => void moveSelected()}
            >
              移动到…
            </button>
            <button
              type="button"
              className="btn btn--small btn--danger"
              disabled={selected.length === 0}
              onClick={() => void trashItems(selected)}
            >
              删除到回收站
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
            {items.map((item) => {
              const missing = item.status === 'missing'
              const checked = selected.includes(item.id)
              const editing = renaming?.id === item.id
              return (
                <li key={item.id} className={missing ? 'dl-item dl-item--missing' : 'dl-item'}>
                  <input
                    type="checkbox"
                    className="dl-item__check"
                    checked={checked}
                    disabled={missing}
                    aria-label={`选择 ${item.fileName}`}
                    onChange={() => toggleOne(item.id)}
                  />
                  <div className="dl-item__main">
                    {editing ? (
                      <form
                        className="rename-row"
                        onSubmit={(event) => {
                          event.preventDefault()
                          void submitRename()
                        }}
                      >
                        <input
                          autoFocus
                          value={renaming.value}
                          aria-label="新的文件名"
                          onChange={(event) =>
                            setRenaming({ id: item.id, value: event.target.value })
                          }
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') setRenaming(null)
                          }}
                        />
                        {/* 扩展名固定显示，用户只改主体名，避免改成别的类型 */}
                        <span className="rename-row__ext">
                          {item.fileName.slice(item.fileName.lastIndexOf('.'))}
                        </span>
                        <button type="submit" className="btn btn--small btn--primary">
                          确定
                        </button>
                        <button
                          type="button"
                          className="btn btn--small btn--ghost"
                          onClick={() => setRenaming(null)}
                        >
                          取消
                        </button>
                      </form>
                    ) : (
                      <button
                        type="button"
                        className="dl-item__name"
                        disabled={missing}
                        title={missing ? '文件已不在磁盘上' : '用系统默认程序打开'}
                        onClick={() =>
                          void act(() => window.api.library.open(item.id), '已用默认程序打开')
                        }
                      >
                        {item.fileName}
                      </button>
                    )}
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
                      onClick={() =>
                        void act(() => window.api.library.reveal(item.id), '已在文件夹中定位')
                      }
                    >
                      打开位置
                    </button>
                    <button
                      type="button"
                      className="btn btn--small"
                      disabled={missing}
                      onClick={() => {
                        const ext = item.fileName.lastIndexOf('.')
                        setRenaming({
                          id: item.id,
                          value: ext > 0 ? item.fileName.slice(0, ext) : item.fileName
                        })
                      }}
                    >
                      重命名
                    </button>
                    <button
                      type="button"
                      className="btn btn--small"
                      onClick={() => void openProps(item.id)}
                    >
                      属性
                    </button>
                    {!missing && isImageFile(item.fileName) ? (
                      <button
                        type="button"
                        className="btn btn--small"
                        onClick={() => setMediaTargets([item.id])}
                      >
                        处理
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn--small btn--ghost"
                      disabled={missing}
                      onClick={() => void trashItems([item.id])}
                    >
                      删除
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

      {propsItem ? (
        <FilePropsDialog
          props={propsItem}
          onClose={() => setPropsItem(null)}
          onCopyPath={() => {
            void act(() => window.api.library.copyPath(propsItem.id), '路径已复制')
          }}
          onReveal={() => {
            void act(() => window.api.library.reveal(propsItem.id), '已在文件夹中定位')
          }}
        />
      ) : null}

      {mediaTargets ? (
        <ImageProcessDialog
          fileIds={mediaTargets}
          onClose={() => setMediaTargets(null)}
          onDone={() => void load(page)}
        />
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  )
}
