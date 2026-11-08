import { formatDuration, formatSize, thumbSrc, typeLabel } from '../format'
import type { SearchResultItem } from '@shared/types'

interface Point {
  x: number
  y: number
}

interface Props {
  item: SearchResultItem
  onPreview: (item: SearchResultItem) => void
  onOpen: (assetId: number) => void
  onMenu: (item: SearchResultItem, point: Point) => void
  /** 多选与快速下载由页面决定是否提供，卡片本身不关心队列逻辑 */
  selected?: boolean
  onToggleSelect?: (item: SearchResultItem) => void
  onDownload?: (item: SearchResultItem) => void
  /** 收藏状态由页面统一维护，卡片只负责显示与回调 */
  favorited?: boolean
  onToggleFavorite?: (item: SearchResultItem) => void
}

export default function AssetCard({
  item,
  onPreview,
  onOpen,
  onMenu,
  selected = false,
  onToggleSelect,
  onDownload,
  favorited = false,
  onToggleFavorite
}: Props) {
  const src = thumbSrc(item.thumbName)

  return (
    <article className={selected ? 'card card--selected' : 'card'}>
      {onToggleSelect ? (
        <input
          type="checkbox"
          className="card__select"
          checked={selected}
          onChange={() => onToggleSelect(item)}
          aria-label={`选择 ${item.title}`}
        />
      ) : null}

      <button
        type="button"
        className="card__thumb"
        onClick={() => onPreview(item)}
        aria-label={`预览 ${item.title}`}
      >
        {src ? (
          <img src={src} alt="" loading="lazy" draggable={false} />
        ) : (
          <span className="card__placeholder">暂无缩略图</span>
        )}
        {item.type === 'video' ? (
          <span className="card__duration">{formatDuration(item.durationSec)}</span>
        ) : null}
      </button>

      <div className="card__body">
        <button type="button" className="card__title" onClick={() => onOpen(item.id)}>
          {item.title}
        </button>

        <div className="card__meta">
          <span>{typeLabel(item.type)}</span>
          <span>{formatSize(item.sizeBytes)}</span>
          <span className="card__free">免费</span>
        </div>

        <div className="card__foot">
          <button type="button" className="card__source" onClick={() => onOpen(item.id)}>
            {typeLabel(item.type)}来自 {item.sourceName}
          </button>
          <span className="card__actions">
            {onToggleFavorite ? (
              <button
                type="button"
                className={favorited ? 'card__favorite card__favorite--on' : 'card__favorite'}
                onClick={() => onToggleFavorite(item)}
                aria-label={favorited ? `取消收藏 ${item.title}` : `收藏 ${item.title}`}
                aria-pressed={favorited}
              >
                {favorited ? '已收藏' : '收藏'}
              </button>
            ) : null}
            {onDownload ? (
              <button
                type="button"
                className="card__download"
                onClick={() => onDownload(item)}
                aria-label={`下载 ${item.title}`}
              >
                下载
              </button>
            ) : null}
            <button
              type="button"
              className="card__more"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                onMenu(item, { x: rect.right, y: rect.bottom })
              }}
              aria-label={`更多操作：${item.title}`}
            >
              更多
            </button>
          </span>
        </div>
      </div>
    </article>
  )
}
