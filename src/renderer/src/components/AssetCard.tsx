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
}

export default function AssetCard({ item, onPreview, onOpen, onMenu }: Props) {
  const src = thumbSrc(item.thumbName)

  return (
    <article className="card">
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
        </div>
      </div>
    </article>
  )
}
