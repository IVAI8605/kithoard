import type { RecoveryReport } from '@shared/types'

interface Props {
  report: RecoveryReport
  onStart: () => void
  onLater: () => void
  onOpenDownloads: () => void
}

/**
 * 启动恢复询问（§5.4）：queued 一律不自动开始，必须由用户确认。
 * 只报数量不列清单：清单在下载管理页可见，弹窗再列一遍反而挡住启动。
 */
export default function StartupRecoveryDialog({ report, onStart, onLater, onOpenDownloads }: Props) {
  return (
    <div className="overlay" role="presentation">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="recovery-title">
        <div className="dialog__head">
          <h2 id="recovery-title">上次还有任务没结束</h2>
        </div>

        <div className="dialog__section">
          <p className="state__text">
            有 {report.pendingQueued} 个任务在排队。按规则它们不会自动开始，需要你确认后才会继续下载。
          </p>
          {report.corrected > 0 ? (
            <p className="muted">
              已按磁盘实际情况校正 {report.corrected} 条记录
              {report.failed > 0 ? `，其中 ${report.failed} 条因临时文件丢失需要重下` : ''}。
            </p>
          ) : null}
          {report.quarantined > 0 ? (
            <p className="muted">隔离区里还有 {report.quarantined} 个文件等你处理。</p>
          ) : null}
        </div>

        <div className="detail__actions">
          <button type="button" className="btn btn--primary" onClick={onStart}>
            开始下载
          </button>
          <button type="button" className="btn" onClick={onOpenDownloads}>
            先去下载管理看看
          </button>
          <button type="button" className="btn btn--ghost" onClick={onLater}>
            稍后再说
          </button>
        </div>
      </div>
    </div>
  )
}
