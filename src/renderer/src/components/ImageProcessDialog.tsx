import { useEffect, useRef, useState } from 'react'
import type { ImageFormat, ImageProcessOptions, MediaTaskItem } from '@shared/types'

const FORMATS: Array<{ value: ImageFormat; label: string }> = [
  { value: 'jpeg', label: 'JPG' },
  { value: 'png', label: 'PNG' },
  { value: 'webp', label: 'WebP' },
  { value: 'avif', label: 'AVIF' }
]

interface Props {
  fileIds: number[]
  onClose: () => void
  /** 任务结束后通知页面刷新本地素材列表 */
  onDone: () => void
}

/**
 * 图片处理面板（§7.6）：转换、压缩、编辑共用一次批量任务。
 * 压缩默认覆盖原文件，界面必须提前说清楚；转换与编辑另存新文件。
 */
export default function ImageProcessDialog({ fileIds, onClose, onDone }: Props) {
  const [action, setAction] = useState<'convert' | 'compress' | 'edit'>('convert')
  const [format, setFormat] = useState<ImageFormat>('webp')
  const [quality, setQuality] = useState('')
  const [rotate, setRotate] = useState('0')
  const [flip, setFlip] = useState<'none' | 'horizontal' | 'vertical'>('none')
  const [width, setWidth] = useState('')
  const [height, setHeight] = useState('')
  const [crop, setCrop] = useState({ left: '', top: '', width: '', height: '' })

  const [taskId, setTaskId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [finished, setFinished] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: fileIds.length, failed: 0 })
  const [failures, setFailures] = useState<MediaTaskItem[]>([])
  const [error, setError] = useState<string | null>(null)

  // 父组件的 onDone 每次渲染都是新函数；用 ref 固定引用，避免事件订阅被反复重建
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => {
    const off = window.api.media.onProgress((event) => {
      setProgress({ done: event.done, total: event.total, failed: event.failed })
      if (event.item.state === 'failed') {
        setFailures((prev) => [...prev, event.item])
      }
      if (event.done >= event.total) {
        setRunning(false)
        setFinished(true)
        onDoneRef.current()
      }
    })
    return off
  }, [])

  const parseNumber = (value: string): number | undefined => {
    if (value.trim() === '') return undefined
    const number = Number(value)
    return Number.isFinite(number) ? number : Number.NaN
  }

  const collect = (): ImageProcessOptions | null => {
    setError(null)
    const qualityValue = parseNumber(quality)
    if (qualityValue !== undefined && (!Number.isInteger(qualityValue) || qualityValue < 1 || qualityValue > 100)) {
      setError('质量请填 1–100 的整数')
      return null
    }

    if (action === 'convert') {
      return { action, format, ...(qualityValue !== undefined ? { quality: qualityValue } : {}) }
    }
    if (action === 'compress') {
      return { action, ...(qualityValue !== undefined ? { quality: qualityValue } : {}) }
    }

    const edit: ImageProcessOptions['edit'] = {}
    const rotation = Number(rotate)
    if (rotation > 0) edit.rotate = rotation
    if (flip !== 'none') edit.flip = flip
    const resizeWidth = parseNumber(width)
    const resizeHeight = parseNumber(height)
    if (Number.isNaN(resizeWidth) || Number.isNaN(resizeHeight)) {
      setError('宽高请填数字')
      return null
    }
    if (resizeWidth !== undefined || resizeHeight !== undefined) {
      edit.resize = {
        ...(resizeWidth !== undefined ? { width: resizeWidth } : {}),
        ...(resizeHeight !== undefined ? { height: resizeHeight } : {})
      }
    }
    const cropValues = [crop.left, crop.top, crop.width, crop.height]
    const cropNumbers = cropValues.map(parseNumber)
    if (cropNumbers.some((value) => Number.isNaN(value))) {
      setError('裁剪参数请填数字')
      return null
    }
    if (cropValues.some((value) => value.trim() !== '')) {
      if (cropNumbers.some((value) => value === undefined)) {
        setError('裁剪需要同时填写左、上、宽、高')
        return null
      }
      edit.crop = {
        left: cropNumbers[0] as number,
        top: cropNumbers[1] as number,
        width: cropNumbers[2] as number,
        height: cropNumbers[3] as number
      }
    }
    if (!edit.rotate && !edit.flip && !edit.resize && !edit.crop) {
      setError('至少选择一种编辑操作')
      return null
    }
    return { action, edit }
  }

  const submit = async (): Promise<void> => {
    const options = collect()
    if (!options) return
    setRunning(true)
    setFinished(false)
    setFailures([])
    setProgress({ done: 0, total: fileIds.length, failed: 0 })
    const result = await window.api.media.start(fileIds, options)
    if (!result.ok) {
      setRunning(false)
      setError(result.error.message)
      return
    }
    setTaskId(result.data.taskId)
  }

  const cancel = async (): Promise<void> => {
    if (!taskId) return
    await window.api.media.cancel(taskId)
  }

  const closed = finished || !running

  return (
    <div className="overlay" role="presentation" onClick={() => (running ? null : onClose())}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="media-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog__head">
          <h2 id="media-title">图片处理（{fileIds.length} 个文件）</h2>
        </div>

        <div className="dialog__section">
          <div className="filters" role="group" aria-label="处理方式">
            {(['convert', 'compress', 'edit'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={action === value ? 'chip chip--on' : 'chip'}
                aria-pressed={action === value}
                disabled={running}
                onClick={() => setAction(value)}
              >
                {value === 'convert' ? '格式转换' : value === 'compress' ? '压缩' : '编辑'}
              </button>
            ))}
          </div>

          {action === 'convert' ? (
            <label className="dialog__form">
              <span>输出格式</span>
              <select
                value={format}
                aria-label="输出格式"
                disabled={running}
                onChange={(event) => setFormat(event.target.value as ImageFormat)}
              >
                {FORMATS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {action !== 'edit' ? (
            <label className="dialog__form">
              <span>{action === 'compress' ? '质量（留空自动）' : '质量 1–100（留空自动）'}</span>
              <input
                type="number"
                min={1}
                max={100}
                value={quality}
                disabled={running}
                placeholder="自动"
                onChange={(event) => setQuality(event.target.value)}
              />
            </label>
          ) : (
            <>
              <div className="media-grid">
                <label>
                  <span>旋转</span>
                  <select
                    value={rotate}
                    disabled={running}
                    onChange={(event) => setRotate(event.target.value)}
                  >
                    <option value="0">不旋转</option>
                    <option value="90">顺时针 90°</option>
                    <option value="180">180°</option>
                    <option value="270">顺时针 270°</option>
                  </select>
                </label>
                <label>
                  <span>翻转</span>
                  <select
                    value={flip}
                    disabled={running}
                    onChange={(event) => setFlip(event.target.value as typeof flip)}
                  >
                    <option value="none">不翻转</option>
                    <option value="horizontal">水平翻转</option>
                    <option value="vertical">垂直翻转</option>
                  </select>
                </label>
                <label>
                  <span>宽（留空按比例）</span>
                  <input
                    type="number"
                    min={1}
                    value={width}
                    disabled={running}
                    onChange={(event) => setWidth(event.target.value)}
                  />
                </label>
                <label>
                  <span>高（留空按比例）</span>
                  <input
                    type="number"
                    min={1}
                    value={height}
                    disabled={running}
                    onChange={(event) => setHeight(event.target.value)}
                  />
                </label>
              </div>
              <p className="dialog__hint">裁剪（像素，默认不裁剪）</p>
              <div className="media-grid">
                {(['left', 'top', 'width', 'height'] as const).map((key) => (
                  <label key={key}>
                    <span>{key === 'left' ? '左' : key === 'top' ? '上' : key === 'width' ? '宽' : '高'}</span>
                    <input
                      type="number"
                      min={0}
                      value={crop[key]}
                      disabled={running}
                      onChange={(event) => setCrop({ ...crop, [key]: event.target.value })}
                    />
                  </label>
                ))}
              </div>
            </>
          )}

          {action === 'compress' ? (
            <p className="dialog__warn">
              压缩会覆盖原文件。处理时会先写临时文件并校验，失败则保留原文件。
            </p>
          ) : (
            <p className="dialog__hint">转换与编辑会另存新文件，原文件保持不变。</p>
          )}

          {error ? <p className="dialog__warn">{error}</p> : null}

          {running || finished ? (
            <div className="media-progress" role="status">
              <p>
                进度 {progress.done} / {progress.total}
                {progress.failed > 0 ? ` · 失败 ${progress.failed}` : ''}
              </p>
              <div className="media-progress__bar">
                <span
                  style={{
                    width: `${progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100)}%`
                  }}
                />
              </div>
            </div>
          ) : null}

          {failures.length > 0 ? (
            <ul className="media-failures">
              {failures.slice(0, 10).map((item) => (
                <li key={item.fileId}>
                  {item.fileName}：{item.error}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="detail__actions">
          {running ? (
            <button type="button" className="btn btn--ghost" onClick={() => void cancel()}>
              取消剩余
            </button>
          ) : (
            <button type="button" className="btn" onClick={onClose}>
              {closed && finished ? '关闭' : '取消'}
            </button>
          )}
          <button
            type="button"
            className="btn btn--primary"
            disabled={running}
            onClick={() => void submit()}
          >
            {finished ? '再处理一次' : '开始处理'}
          </button>
        </div>
      </div>
    </div>
  )
}
