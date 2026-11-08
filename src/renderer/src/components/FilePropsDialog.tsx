import type { LocalFileProps } from '@shared/types'
import { formatDateTime, formatSize } from '../format'

interface Props {
  props: LocalFileProps
  onClose: () => void
  onCopyPath: () => void
  onReveal: () => void
}

/**
 * 属性面板：数据全部来自磁盘（主进程 stat），不是列表缓存，
 * 用户从外面改过文件也能看到真实大小与修改时间。
 */
export default function FilePropsDialog({ props, onClose, onCopyPath, onReveal }: Props) {
  return (
    <div className="overlay" role="presentation" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="props-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog__head">
          <h2 id="props-title">文件属性</h2>
        </div>

        <div className="dialog__section">
          <dl className="props">
            <dt>大小</dt>
            <dd>{formatSize(props.size)}</dd>
            <dt>格式</dt>
            <dd>{props.ext ? props.ext.toUpperCase() : '无扩展名'}</dd>
            <dt>创建时间</dt>
            <dd>{formatDateTime(props.createdAt)}</dd>
            <dt>修改时间</dt>
            <dd>{formatDateTime(props.modifiedAt)}</dd>
            <dt>位置</dt>
            <dd className="props__path">{props.path}</dd>
          </dl>
        </div>

        <div className="detail__actions">
          <button type="button" className="btn" onClick={onReveal}>
            打开位置
          </button>
          <button type="button" className="btn" onClick={onCopyPath}>
            复制路径
          </button>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
