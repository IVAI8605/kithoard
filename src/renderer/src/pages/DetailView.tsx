import { useEffect, useState } from 'react'
import type { AppError } from '@shared/errors'
import type { AssetDetail } from '@shared/types'
import {
  formatDateTime,
  formatDuration,
  formatResolution,
  formatSize,
  licenseLabel,
  thumbSrc,
  typeLabel
} from '../format'

interface Props {
  assetId: number
  onBack: () => void
}

export default function DetailView({ assetId, onBack }: Props) {
  const [detail, setDetail] = useState<AssetDetail | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    setError(null)
    void window.api.asset.detail(assetId).then((response) => {
      if (cancelled) return
      if (response.ok) setDetail(response.data)
      else setError(response.error)
    })
    return () => {
      cancelled = true
    }
  }, [assetId])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const copySource = async (): Promise<void> => {
    if (!detail?.pageUrl) return
    const response = await window.api.clipboard.writeText(detail.pageUrl)
    setToast(response.ok ? '来源链接已复制' : response.error.message)
  }

  const src = thumbSrc(detail?.thumbName ?? null)
  const licenseFree = detail?.license === 'free'

  return (
    <div className="page detail-page">
      <button type="button" className="backlink" onClick={onBack}>
        返回搜索
      </button>

      {!detail && !error ? <p className="status">正在打开详情…</p> : null}

      {error ? (
        <section className="state" role="alert">
          <p className="state__title">{error.message}</p>
          <p className="state__text">可以返回搜索重新选择一条素材。</p>
        </section>
      ) : null}

      {detail ? (
        <article className="detail">
          <div className="detail__media">
            {src ? (
              <img src={src} alt={detail.title} />
            ) : (
              <span className="card__placeholder">暂无缩略图</span>
            )}
          </div>

          <div className="detail__info">
            <p className="detail__origin">
              {typeLabel(detail.type)}来自 {detail.sourceName}
            </p>
            <h1>{detail.title}</h1>

            <dl className="facts">
              <div>
                <dt>类型</dt>
                <dd>{typeLabel(detail.type)}</dd>
              </div>
              <div>
                <dt>分辨率</dt>
                <dd>{formatResolution(detail.width, detail.height)}</dd>
              </div>
              {detail.type === 'video' ? (
                <div>
                  <dt>时长</dt>
                  <dd>{formatDuration(detail.durationSec)}</dd>
                </div>
              ) : null}
              <div>
                <dt>文件大小</dt>
                <dd>{formatSize(detail.sizeBytes)}</dd>
              </div>
              <div>
                <dt>许可状态</dt>
                <dd>{licenseLabel(detail.license)}</dd>
              </div>
              <div>
                <dt>获取时间</dt>
                <dd>{formatDateTime(detail.fetchedAt)}</dd>
              </div>
            </dl>

            {detail.tags.length > 0 ? <p className="detail__tags">标签：{detail.tags.join('、')}</p> : null}

            <div className="detail__actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled
                title={licenseFree ? 'V0.2 提供' : '授权状态不支持下载'}
              >
                {licenseFree ? '下载（V0.2 提供）' : '授权不支持下载'}
              </button>
              <button type="button" className="btn" disabled title="V0.3 提供">
                收藏（V0.3 提供）
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => void copySource()}
                disabled={!detail.pageUrl}
              >
                复制来源链接
              </button>
              {detail.pageUrl ? (
                <a className="btn" href={detail.pageUrl} target="_blank" rel="noreferrer">
                  在 {detail.sourceName} 打开
                </a>
              ) : null}
            </div>

            <p className="detail__note">
              {licenseFree
                ? 'V0.1 只做搜索与详情，下载与收藏会在后续版本上线。'
                : `当前授权状态为「${licenseLabel(detail.license)}」，已禁用下载。`}
            </p>

            {detail.attribution ? (
              <p className="detail__attribution">
                {detail.attribution.text}。
                <a href={detail.attribution.url} target="_blank" rel="noreferrer">
                  查看原页面
                </a>
              </p>
            ) : null}

            <section className="detail__risk">
              <h2>版权与使用提醒</h2>
              <p>
                Pixabay 内容许可允许免费商用，但素材里出现人物、商标或地标时，仍需自行确认肖像权、商标权等第三方权利。
              </p>
            </section>

            <p className="detail__id">
              素材编号 {detail.sourceId} / {detail.remoteId}
            </p>
          </div>
        </article>
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  )
}
