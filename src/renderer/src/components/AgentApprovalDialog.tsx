import { useEffect, useState } from 'react'
import type { AgentApprovalTicket } from '@shared/agent'
import { formatSize } from '../format'

/**
 * Agent 高风险动作的审批框。
 * 为什么挂在应用根节点而不是设置页：agent 随时可能发起请求，
 * 用户此刻很可能不在设置页；审批必须出现在他眼前，否则就会一直挂着直到超时。
 */
export default function AgentApprovalDialog() {
  const [queue, setQueue] = useState<AgentApprovalTicket[]>([])
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    // 先取一次已挂起的审批：页面刷新会错过之前推送的事件
    void window.api.agent.status().then((res) => {
      if (res.ok) setQueue(res.data.pendingApprovals)
    })
    const off = window.api.agent.onApproval((ticket) => {
      setQueue((current) =>
        current.some((item) => item.id === ticket.id) ? current : [...current, ticket]
      )
    })
    return off
  }, [])

  useEffect(() => {
    if (queue.length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [queue.length])

  const ticket = queue[0]
  if (!ticket) return null

  async function decide(allow: boolean) {
    if (!ticket) return
    await window.api.agent.decide(ticket.id, allow)
    setQueue((current) => current.filter((item) => item.id !== ticket.id))
  }

  const remainSeconds = Math.max(0, Math.ceil((ticket.expiresAt - now) / 1000))
  const { preview } = ticket

  return (
    <div className="overlay">
      <section className="dialog" role="dialog" aria-modal="true" aria-label="Agent 操作确认">
        <header className="dialog__head">
          <h2>Agent 请求执行高风险操作</h2>
        </header>

        <div className="dialog__section">
          <h3>{preview.action}</h3>
          <p className="dialog__hint">
            共 {preview.count} 个对象
            {preview.totalBytes === null ? '，总大小未知' : `，合计 ${formatSize(preview.totalBytes)}`}
            ；{preview.reversible ? '可还原' : '不可还原'}。
            剩余 {remainSeconds} 秒，超时需要重新申请。
          </p>
          <p className="dialog__hint">
            下面是这次会被影响的完整路径清单，请逐条确认后再决定：
          </p>
          <div style={{ maxHeight: '40vh', overflowY: 'auto' }}>
            {preview.paths.length === 0 ? (
              <p className="dialog__warn">清单为空，请拒绝并检查 agent 参数。</p>
            ) : (
              preview.paths.map((item, index) => (
                <p key={`${index}-${item}`} className="dialog__hint" style={{ wordBreak: 'break-all' }}>
                  {item}
                </p>
              ))
            )}
          </div>
          {queue.length > 1 ? (
            <p className="dialog__hint">还有 {queue.length - 1} 个待确认请求，处理完这个会接着显示。</p>
          ) : null}
        </div>

        <div className="dialog__section">
          <div className="settings-inline">
            <button type="button" className="btn btn--primary" onClick={() => void decide(true)}>
              允许一次
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => void decide(false)}>
              拒绝
            </button>
          </div>
          <p className="dialog__hint">
            允许只对这一批参数生效、只执行一次；agent 换参数或再来一次都要重新确认。
          </p>
        </div>
      </section>
    </div>
  )
}
