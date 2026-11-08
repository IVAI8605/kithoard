import { useState } from 'react'
import type { MediaAction, MediaProcessOptions } from '@shared/types'
import { useMediaTask } from '../hooks/useMediaTask'

interface Props {
  fileIds: number[]
  kind: 'video' | 'audio'
  onClose: () => void
  onDone: () => void
}

const TIME_PATTERN = /^\d{2}:\d{2}:\d{2}(\.\d{1,2})?$/

/**
 * 音视频处理面板（§7.7）：转码、压缩、截图/截取共用一次批量任务。
 * 所有动作都另存新文件，原文件不动。
 */
export default function MediaProcessDialog({ fileIds, kind, onClose, onDone }: Props) {
  const [action, setAction] = useState<MediaAction>(
    kind === 'video' ? 'videoConvert' : 'audioConvert'
  )
  const [width, setWidth] = useState('')
  const [height, setHeight] = useState('')
  const [crf, setCrf] = useState('23')
  const [bitrate, setBitrate] = useState('')
  const [at, setAt] = useState('00:00:05')
  const [audioFormat, setAudioFormat] = useState<'mp3' | 'aac' | 'wav' | 'flac'>('mp3')
  const [startTime, setStartTime] = useState('00:00:00')
  const [endTime, setEndTime] = useState('00:00:05')
  const task = useMediaTask(onDone)

  const collect = (): MediaProcessOptions | null => {
    task.setError(null)
    if (kind === 'video' && action === 'videoConvert') {
      const widthValue = width.trim() ? Number(width) : undefined
      const heightValue = height.trim() ? Number(height) : undefined
      const crfValue = crf.trim() ? Number(crf) : undefined
      if (widthValue !== undefined && (!Number.isInteger(widthValue) || widthValue < 1)) {
        task.setError('宽度请填正整数')
        return null
      }
      if (heightValue !== undefined && (!Number.isInteger(heightValue) || heightValue < 1)) {
        task.setError('高度请填正整数')
        return null
      }
      if (crfValue !== undefined && (!Number.isInteger(crfValue) || crfValue < 0 || crfValue > 51)) {
        task.setError('CRF 请填 0–51 的整数')
        return null
      }
      if (bitrate.trim() && !/^\d+k$/i.test(bitrate.trim())) {
        task.setError('码率格式示例：1500k')
        return null
      }
      return {
        action: 'videoConvert',
        ...(widthValue !== undefined ? { width: widthValue } : {}),
        ...(heightValue !== undefined ? { height: heightValue } : {}),
        ...(crfValue !== undefined ? { crf: crfValue } : {}),
        ...(bitrate.trim() ? { bitrate: bitrate.trim() } : {})
      }
    }
    if (kind === 'video' && action === 'videoCompress') return { action: 'videoCompress' }
    if (kind === 'video' && action === 'videoScreenshot') {
      if (!TIME_PATTERN.test(at)) {
        task.setError('时间格式示例：00:00:05')
        return null
      }
      return { action: 'videoScreenshot', at }
    }
    if (kind === 'audio' && action === 'audioConvert') {
      if (bitrate.trim() && !/^\d+k$/i.test(bitrate.trim())) {
        task.setError('码率格式示例：128k')
        return null
      }
      return {
        action: 'audioConvert',
        format: audioFormat,
        ...(bitrate.trim() ? { bitrate: bitrate.trim() } : {})
      }
    }
    if (kind === 'audio' && action === 'audioCompress') return { action: 'audioCompress' }
    if (!TIME_PATTERN.test(startTime) || !TIME_PATTERN.test(endTime)) {
      task.setError('时间格式示例：00:00:05')
      return null
    }
    if (startTime >= endTime) {
      task.setError('开始时间必须早于结束时间')
      return null
    }
    return { action: 'audioExtract', start: startTime, end: endTime }
  }

  const submit = async (): Promise<void> => {
    const options = collect()
    if (!options) return
    await task.start(fileIds, options)
  }

  return (
    <div className="overlay" role="presentation" onClick={() => (task.running ? null : onClose())}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="media-av-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog__head">
          <h2 id="media-av-title">
            {kind === 'video' ? '视频处理' : '音频处理'}（{fileIds.length} 个文件）
          </h2>
        </div>

        <div className="dialog__section">
          <div className="filters" role="group" aria-label="处理方式">
            {(kind === 'video'
              ? ([
                  ['videoConvert', '转码'],
                  ['videoCompress', '压缩'],
                  ['videoScreenshot', '截图']
                ] as const)
              : ([
                  ['audioConvert', '转码'],
                  ['audioCompress', '压缩'],
                  ['audioExtract', '截取']
                ] as const)
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={action === value ? 'chip chip--on' : 'chip'}
                aria-pressed={action === value}
                disabled={task.running}
                onClick={() => setAction(value)}
              >
                {label}
              </button>
            ))}
          </div>

          {action === 'videoConvert' ? (
            <div className="media-grid">
              <label>
                <span>宽（留空保持）</span>
                <input type="number" min={1} value={width} disabled={task.running} onChange={(e) => setWidth(e.target.value)} />
              </label>
              <label>
                <span>高（留空保持）</span>
                <input type="number" min={1} value={height} disabled={task.running} onChange={(e) => setHeight(e.target.value)} />
              </label>
              <label>
                <span>CRF（0–51，越大越小）</span>
                <input type="number" min={0} max={51} value={crf} disabled={task.running} onChange={(e) => setCrf(e.target.value)} />
              </label>
              <label>
                <span>码率（可选，如 1500k）</span>
                <input value={bitrate} disabled={task.running} onChange={(e) => setBitrate(e.target.value)} />
              </label>
            </div>
          ) : null}

          {action === 'videoCompress' ? (
            <p className="dialog__hint">自动使用 CRF 28 压缩，输出 mp4；原文件保持不变。</p>
          ) : null}

          {action === 'videoScreenshot' ? (
            <label className="dialog__form">
              <span>截图时间</span>
              <input value={at} disabled={task.running} onChange={(e) => setAt(e.target.value)} />
            </label>
          ) : null}

          {action === 'audioConvert' ? (
            <div className="media-grid">
              <label>
                <span>输出格式</span>
                <select
                  value={audioFormat}
                  disabled={task.running}
                  onChange={(e) => setAudioFormat(e.target.value as typeof audioFormat)}
                >
                  <option value="mp3">MP3</option>
                  <option value="aac">AAC</option>
                  <option value="wav">WAV</option>
                  <option value="flac">FLAC</option>
                </select>
              </label>
              <label>
                <span>码率（可选，如 128k）</span>
                <input value={bitrate} disabled={task.running} onChange={(e) => setBitrate(e.target.value)} />
              </label>
            </div>
          ) : null}

          {action === 'audioCompress' ? (
            <p className="dialog__hint">自动使用 128k 码率压缩为 MP3，原文件保持不变。</p>
          ) : null}

          {action === 'audioExtract' ? (
            <div className="media-grid">
              <label>
                <span>开始时间</span>
                <input value={startTime} disabled={task.running} onChange={(e) => setStartTime(e.target.value)} />
              </label>
              <label>
                <span>结束时间</span>
                <input value={endTime} disabled={task.running} onChange={(e) => setEndTime(e.target.value)} />
              </label>
            </div>
          ) : null}

          <p className="dialog__hint">处理会另存新文件，原文件保持不变；支持批量，单条失败不影响其他文件。</p>
          {task.error ? <p className="dialog__warn">{task.error}</p> : null}

          {task.running || task.finished ? (
            <div className="media-progress" role="status">
              <p>
                进度 {task.progress.done} / {task.progress.total}
                {task.progress.failed > 0 ? ` · 失败 ${task.progress.failed}` : ''}
              </p>
              <div className="media-progress__bar">
                <span
                  style={{
                    width: `${task.progress.total === 0 ? 0 : Math.round((task.progress.done / task.progress.total) * 100)}%`
                  }}
                />
              </div>
            </div>
          ) : null}

          {task.failures.length > 0 ? (
            <ul className="media-failures">
              {task.failures.slice(0, 10).map((item) => (
                <li key={item.fileId}>
                  {item.fileName}：{item.error}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="detail__actions">
          {task.running ? (
            <button type="button" className="btn btn--ghost" onClick={() => void task.cancel()}>
              取消剩余
            </button>
          ) : (
            <button type="button" className="btn" onClick={onClose}>
              关闭
            </button>
          )}
          <button type="button" className="btn btn--primary" disabled={task.running} onClick={() => void submit()}>
            {task.finished ? '再处理一次' : '开始处理'}
          </button>
        </div>
      </div>
    </div>
  )
}
