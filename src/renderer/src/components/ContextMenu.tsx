import { useEffect } from 'react'
import type { SearchResultItem } from '@shared/types'

interface Props {
  item: SearchResultItem
  x: number
  y: number
  onClose: () => void
  onPreview: () => void
  onDetail: () => void
  onCopy: () => void
}

const MENU_WIDTH = 220
const MENU_HEIGHT = 210

export default function ContextMenu({
  item,
  x,
  y,
  onClose,
  onPreview,
  onDetail,
  onCopy
}: Props) {
  useEffect(() => {
    const close = (): void => onClose()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // 菜单靠近屏幕边缘时向内收，避免按钮被裁掉
  const left = Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 8))
  const top = Math.max(8, Math.min(y, window.innerHeight - MENU_HEIGHT - 8))

  return (
    <div className="menu" role="menu" aria-label="素材操作" style={{ left, top }}>
      <button type="button" role="menuitem" onClick={onPreview}>
        预览
      </button>
      <button type="button" role="menuitem" onClick={onDetail}>
        查看详情
      </button>
      <button type="button" role="menuitem" onClick={onCopy} disabled={!item.pageUrl}>
        复制来源链接
      </button>
      <button type="button" role="menuitem" disabled title="V0.2 提供">
        下载
        <span className="menu__note">V0.2 提供</span>
      </button>
      <button type="button" role="menuitem" disabled title="V0.3 提供">
        收藏
        <span className="menu__note">V0.3 提供</span>
      </button>
    </div>
  )
}
