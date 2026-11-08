import { useEffect } from 'react'
import { formatDuration, thumbSrc, typeLabel } from '../format'
import type { SearchResultItem } from '@shared/types'

interface Props {
  item: SearchResultItem
  onClose: () => void
  onDetail: () => void
}

export default function PreviewDialog({ item, onClose, onDetail }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const src = thumbSrc(item.thumbName)

  return (
    <div className="overlay" onClick={onClose} role="presentation">
      <section
        className="preview"
        role="dialog"
        aria-modal="true"
        aria-label={`预览 ${item.title}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="preview__media">
          {src ? <img src={src} alt={item.title} /> : <span className="card__placeholder">暂无缩略图</span>}
        </div>
        <div className="preview__bar">
          <div>
            <p className="preview__title">{item.title}</p>
            <p className="preview__meta">
              <span>{typeLabel(item.type)}</span>
              <span>{formatDuration(item.durationSec)}</span>
              <span>免费</span>
            </p>
          </div>
          <div className="preview__actions">
            <button type="button" className="btn" onClick={onDetail}>
              查看详情
            </button>
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
