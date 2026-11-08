import { useEffect, useState } from 'react'
import type { AppError } from '@shared/errors'
import type { DownloadTask, QuarantineItem } from '@shared/types'
import {
  actionsOf,
  errorText,
  fileNameOf,
  formatBytes,
  formatProgress,
  isFinished,
  moveTask,
  progressPercent,
  stateLabel,
  stateTone
} from '../downloadView'
import { formatDateTime } from '../format'
import { useAppStore } from '../store'

interface Props {
  onOpenDetail: (assetId: number) => void
}

export default function DownloadsPage({ onOpenDetail }: Props) {
  const downloads = useAppStore((state) => state.downloads)
  const downloadsLoaded = useAppStore((state) => state.downloadsLoaded)
  const quarantineItems = useAppStore((state) => state.quarantineItems)
  const quarantineLoaded = useAppStore((state) => state.quarantineLoaded)
  const loadDownloads = useAppStore((state) => state.loadDownloads)
  const loadQuarantine = useAppStore((state) => state.loadQuarantine)
  const pauseTask = useAppStore((state) => state.pauseTask)
  const cancelTask = useAppStore((state) => state.cancelTask)
  const resumeTask = useAppStore((state) => state.resumeTask)
  const retryTask = useAppStore((state) => state.retryTask)
  const reorderTasks = useAppStore((state) => state.reorderTasks)
  const startQueue = useAppStore((state) => state.startQueue)
  const restoreQuarantine = useAppStore((state) => state.restoreQuarantine)
  const discardQuarantine = useAppStore((state) => state.discardQuarantine)

  const [toast, setToast] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)

  useEffect(() => {
    void loadDownloads()
    void loadQuarantine()
  }, [loadDownloads, loadQuarantine])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2400)
    return () => window.clearTimeout(timer)
  }, [toast])

  // 隔离任务正常应由隔离区区块展示；若隔离记录丢失（例如手工删了文件），
  // 仍要在队列里露出来，否则用户会看到「任务消失了」却查不到任何线索
  const quarantinedIds = new Set(
    quarantineItems.map((item) => item.downloadId).filter((id): id is string => id !== null)
  )
  const active = downloads.filter(
    (task) => !isFinished(task.state) && (task.state !== 'quarantined' || !quarantinedIds.has(task.id))
  )
  const finished = downloads.filter((task) => isFinished(task.state))
  // §7.8-3：隔离区里超过 30 天未处理的条数，在标题旁提醒一次，不弹窗打扰
  const staleQuarantineCount = quarantineItems.filter(
    (item) => Date.now() - item.createdAt > 30 * 24 * 60 * 60 * 1000
  ).length
  const pendingQueued = downloads.filter((task) => task.state === 'queued').length
  const failedCount = downloads.filter((task) => task.state === 'failed').length
  const completedCount = downloads.filter((task) => task.state === 'completed').length
  const empty = downloadsLoaded && quarantineLoaded && downloads.length === 0 && quarantineItems.length === 0

  const act = async (promise: Promise<AppError | null>, okText?: string): Promise<void> => {
    const error = await promise
    // 主进程的 message 已经是可读中文；技术细节收在错误对象里，不在列表页展开
    setToast(error ? error.message : okText ?? null)
  }

  const handleRetry = (task: DownloadTask): void => {
    // 与 §5.3 一致：超过 3 次仍失败说明重试解决不了问题，必须让用户明确确认一次
    if (task.retryCount >= 3) {
      const confirmed = window.confirm(`这条任务已经失败 ${task.retryCount} 次，还要继续重试吗？`)
      if (!confirmed) return
      void act(retryTask(task.id, true), '已重新排队')
      return
    }
    void act(retryTask(task.id), '已重新排队')
  }

  const handleDrop = (targetId: string): void => {
    if (!dragId || dragId === targetId) return
    const activeIds = active.map((task) => task.id)
    const next = moveTask(activeIds, dragId, targetId)
    // 只有进行中的任务参与排序；已完成/已取消按原相对顺序排到后面，避免顺序无端变化
    const rest = downloads.filter((task) => !activeIds.includes(task.id)).map((task) => task.id)
    setDragId(null)
    void act(reorderTasks([...next, ...rest]))
  }

  const handleRestore = (item: QuarantineItem): void => {
    void act(restoreQuarantine(item.id), '文件已恢复到原位置')
  }

  const handleDiscard = (item: QuarantineItem): void => {
    const confirmed = window.confirm('放弃后文件会移入系统回收站，仍可从回收站找回。确定放弃吗？')
    if (!confirmed) return
    void act(discardQuarantine(item.id), '已移入系统回收站')
  }

  return (
    <div className="page">
      <header className="page__head">
        <h1>下载管理</h1>
        <p className="page__lead">下载完成才会进入本地素材库；暂停后可从断点继续。</p>
      </header>

      {pendingQueued > 0 ? (
        <section className="notice" aria-label="有排队任务">
          <div>
            <p className="notice__title">有 {pendingQueued} 个任务在排队</p>
            <p className="notice__text">上次退出前没有开始，确认后才会真正下载。</p>
          </div>
          <button type="button" className="btn btn--primary" onClick={() => void act(startQueue(), '已开始下载')}>
            开始下载
          </button>
        </section>
      ) : null}

      {downloads.length > 0 ? (
        <p className="dl-summary">
          <span>进行中 {active.filter((task) => task.state === 'downloading').length}</span>
          <span>排队 {pendingQueued}</span>
          <span>已完成 {completedCount}</span>
          {failedCount > 0 ? <span className="dl-summary__warn">失败 {failedCount}</span> : null}
        </p>
      ) : null}

      {empty ? (
        <section className="state">
          <p className="state__title">还没有下载任务</p>
          <p className="state__text">
            {downloadsLoaded ? '去首页搜索素材，选中后点「下载」就会出现在这里。' : '正在读取下载记录…'}
          </p>
        </section>
      ) : null}

      {active.length > 0 ? (
        <section className="dl-section">
          <div className="dl-section__head">
            <h2>未结束</h2>
            <p className="dl-section__note">拖动左侧把手调整顺序；失败的任务可以直接重试。</p>
          </div>
          <ul className="dl-list">
            {active.map((task) => {
              const actions = actionsOf(task.state)
              const percent = progressPercent(task.receivedBytes, task.totalBytes)
              const error = errorText(task.errorCode)
              return (
                <li
                  key={task.id}
                  className={dragId === task.id ? 'dl-item dl-item--drag' : 'dl-item'}
                  draggable
                  onDragStart={() => setDragId(task.id)}
                  onDragEnd={() => setDragId(null)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => handleDrop(task.id)}
                >
                  <span className="dl-item__handle" aria-hidden="true">
                    ⋮⋮
                  </span>
                  <div className="dl-item__main">
                    <button
                      type="button"
                      className="dl-item__name"
                      onClick={() => task.assetId !== null && onOpenDetail(task.assetId)}
                      disabled={task.assetId === null}
                    >
                      {task.title ?? task.fileName}
                    </button>
                    <p className="dl-item__sub">{fileNameOf(task.targetPath)}</p>
                    <div
                      className="dl-bar"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={percent ?? undefined}
                      aria-label={`${stateLabel(task.state)}进度`}
                    >
                      <span
                        className={`dl-bar__fill dl-bar__fill--${stateTone(task.state)}`}
                        style={{ width: `${percent ?? 0}%` }}
                      />
                    </div>
                    <p className="dl-item__meta">
                      <span className={`dl-state dl-state--${stateTone(task.state)}`}>
                        {stateLabel(task.state)}
                      </span>
                      <span>{formatProgress(task.receivedBytes, task.totalBytes)}</span>
                      {percent === null ? null : <span>{percent}%</span>}
                      {error ? <span className="dl-item__error">{error}</span> : null}
                    </p>
                  </div>
                  <div className="dl-item__actions">
                    {actions.pause ? (
                      <button type="button" className="btn btn--small" onClick={() => void act(pauseTask(task.id), '已暂停')}>
                        暂停
                      </button>
                    ) : null}
                    {actions.resume ? (
                      <button type="button" className="btn btn--small" onClick={() => void act(resumeTask(task.id), '已继续')}>
                        继续
                      </button>
                    ) : null}
                    {actions.retry ? (
                      <button type="button" className="btn btn--small" onClick={() => handleRetry(task)}>
                        重试
                      </button>
                    ) : null}
                    {actions.cancel ? (
                      <button type="button" className="btn btn--small btn--ghost" onClick={() => void act(cancelTask(task.id), '已取消')}>
                        取消
                      </button>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      {finished.length > 0 ? (
        <section className="dl-section">
          <div className="dl-section__head">
            <h2>已结束</h2>
            <p className="dl-section__note">完成与取消的任务留在这里方便回看，不影响队列顺序。</p>
          </div>
          <ul className="dl-list">
            {finished.map((task) => (
              <li key={task.id} className="dl-item dl-item--finished">
                <span className="dl-item__handle" aria-hidden="true" />
                <div className="dl-item__main">
                  <button
                    type="button"
                    className="dl-item__name"
                    onClick={() => task.assetId !== null && onOpenDetail(task.assetId)}
                    disabled={task.assetId === null}
                  >
                    {task.title ?? task.fileName}
                  </button>
                  <p className="dl-item__meta">
                    <span className={`dl-state dl-state--${stateTone(task.state)}`}>
                      {stateLabel(task.state)}
                    </span>
                    <span>{formatBytes(task.receivedBytes)}</span>
                    <span>{formatDateTime(task.updatedAt)}</span>
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {quarantineItems.length > 0 ? (
        <section className="dl-section">
          <div className="dl-section__head">
            <h2>隔离区</h2>
            <p className="dl-section__note">
              判定有风险的文件只移到这里，不会自动删除。
              {staleQuarantineCount > 0
                ? ` 其中 ${staleQuarantineCount} 个已超过 30 天，建议尽快恢复或放弃。`
                : ''}
            </p>
          </div>
          <ul className="dl-list">
            {quarantineItems.map((item) => (
              <li key={item.id} className="dl-item dl-item--risk">
                <span className="dl-item__handle" aria-hidden="true">
                  !
                </span>
                <div className="dl-item__main">
                  <p className="dl-item__name">{item.title ?? fileNameOf(item.path)}</p>
                  <p className="dl-item__sub">{fileNameOf(item.path)}</p>
                  <p className="dl-item__meta">
                    <span className="dl-state dl-state--risk">已隔离</span>
                    <span>{formatDateTime(item.createdAt)}</span>
                  </p>
                  <p className="dl-item__error">{item.reason}</p>
                  <p className="dl-item__sub">
                    恢复位置：{item.targetPath ? fileNameOf(item.targetPath) : '原路径已不可用'}
                  </p>
                </div>
                <div className="dl-item__actions">
                  <button type="button" className="btn btn--small" onClick={() => handleRestore(item)}>
                    恢复
                  </button>
                  <button type="button" className="btn btn--small btn--ghost" onClick={() => handleDiscard(item)}>
                    放弃
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  )
}
