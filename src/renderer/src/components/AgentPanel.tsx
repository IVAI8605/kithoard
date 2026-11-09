import { useCallback, useEffect, useState } from 'react'
import type { AgentAuditEntry, AgentScope, AgentStatus } from '@shared/agent'

/**
 * V1.1 Agent 接入面设置区块。
 * 为什么单独立组件：这块的状态（开关、令牌、审计）与下载/素材源互不相干，
 * 塞进 SettingsPage 只会让那个文件继续膨胀，且这里必须独立刷新。
 */
export default function AgentPanel() {
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [audit, setAudit] = useState<AgentAuditEntry[]>([])
  const [auditPath, setAuditPath] = useState('')
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<AgentScope[]>(['read', 'acquire'])
  const [token, setToken] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [statusRes, auditRes, pathRes] = await Promise.all([
      window.api.agent.status(),
      window.api.agent.audit(20),
      window.api.agent.auditPath()
    ])
    if (statusRes.ok) setStatus(statusRes.data)
    if (auditRes.ok) setAudit(auditRes.data)
    if (pathRes.ok) setAuditPath(pathRes.data)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function toggle(enabled: boolean) {
    setBusy(true)
    const res = await window.api.agent.setEnabled(enabled)
    setBusy(false)
    if (res.ok) {
      setStatus(res.data)
      setMessage(enabled ? '已开启，外部客户端现在可以连接' : '已关闭，所有现有连接已断开')
    } else {
      setMessage(res.error.message)
    }
  }

  async function issue() {
    setBusy(true)
    const res = await window.api.agent.issueToken(name, scopes)
    setBusy(false)
    if (res.ok) {
      // 明文只出现这一次：提示用户立刻复制，离开页面后无法再取回
      setToken(res.data.token)
      setName('')
      setMessage('令牌已生成，请立刻复制；关闭本页后无法再次查看')
      await load()
    } else {
      setMessage(res.error.message)
    }
  }

  async function revoke(clientId: string) {
    setBusy(true)
    const res = await window.api.agent.revoke(clientId)
    setBusy(false)
    if (res.ok) setStatus(res.data)
    else setMessage(res.error.message)
  }

  async function revokeAll() {
    setBusy(true)
    const res = await window.api.agent.revokeAll()
    setBusy(false)
    if (res.ok) {
      setStatus(res.data)
      setToken('')
      setMessage('已吊销全部令牌')
    } else {
      setMessage(res.error.message)
    }
  }

  function toggleScope(scope: AgentScope) {
    setScopes((current) =>
      current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope]
    )
  }

  return (
    <section className="settings-block">
      <h2>Agent 接入</h2>
      <p className="page__lead">
        给外部 AI 客户端（MCP / 脚本 / CLI）一个受控入口。默认关闭；开启后只在本机命名管道上监听，
        不开任何网络端口。删除、移动、恢复隔离区这类动作永远需要你在应用内逐次确认。
      </p>

      <div className="settings-row">
        <div>
          <p className="settings-row__label">允许外部连接</p>
          <p className="settings-row__value">
            {status
              ? status.enabled
                ? '已开启，正在监听'
                : '已关闭，外部请求会被明确拒绝'
              : '加载中…'}
            {status ? ` 管道 ${status.pipeName} 接口 v${status.version}` : ''}
          </p>
          {status ? (
            <p className="settings-row__value">
              每分钟上限 {status.limits.perMinute} 次，单批最多 {status.limits.batchMax} 条，
              审批有效期 {Math.round(status.limits.approvalTtlMs / 1000)} 秒
            </p>
          ) : null}
        </div>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={status?.enabled ?? false}
            disabled={busy || !status}
            onChange={(event) => void toggle(event.target.checked)}
          />
          <span>启用</span>
        </label>
      </div>

      <div className="settings-row">
        <div>
          <p className="settings-row__label">生成连接令牌</p>
          <p className="settings-row__value">
            令牌只在这里显示一次，库里只留哈希；随时可以按客户端吊销。
          </p>
          <div className="settings-inline">
            <input
              type="text"
              value={name}
              placeholder="客户端名称，例如 Claude Desktop"
              aria-label="客户端名称"
              disabled={busy || !status?.enabled}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="settings-inline">
            {(['read', 'acquire', 'organize'] as AgentScope[]).map((scope) => (
              <label key={scope} className="switch-row">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  disabled={busy || !status?.enabled}
                  onChange={() => toggleScope(scope)}
                />
                <span>
                  {scope === 'read' ? '只读' : scope === 'acquire' ? '下载' : '整理'}
                </span>
              </label>
            ))}
          </div>
        </div>
        <button
          type="button"
          className="btn btn--small"
          disabled={busy || !status?.enabled || scopes.length === 0}
          onClick={() => void issue()}
        >
          生成
        </button>
      </div>

      {token ? (
        <div className="dialog__warn">
          <p>令牌（只显示这一次，请立刻复制）：</p>
          <p className="settings-row__value" style={{ wordBreak: 'break-all' }}>
            {token}
          </p>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => void window.api.clipboard.writeText(token)}
          >
            复制令牌
          </button>
        </div>
      ) : null}

      <div className="settings-row">
        <div>
          <p className="settings-row__label">已授权客户端</p>
          <p className="settings-row__value">
            {status && status.clients.length > 0
              ? `${status.clients.length} 个客户端`
              : '暂无客户端'}
          </p>
        </div>
        <button
          type="button"
          className="btn btn--small"
          disabled={busy || !status || status.clients.length === 0}
          onClick={() => void revokeAll()}
        >
          全部吊销
        </button>
      </div>

      {(status?.clients ?? []).map((client) => (
        <div key={client.id} className="settings-row">
          <div>
            <p className="settings-row__label">{client.name}</p>
            <p className="settings-row__value">
              编号 {client.id} 作用域 {client.scopes.join(' / ') || '无'}
              {client.lastSeenAt
                ? ` 最近活动 ${new Date(client.lastSeenAt).toLocaleString('zh-CN')}`
                : ' 尚未使用'}
            </p>
          </div>
          <button
            type="button"
            className="btn btn--small"
            disabled={busy}
            onClick={() => void revoke(client.id)}
          >
            断开
          </button>
        </div>
      ))}

      <div className="settings-row">
        <div>
          <p className="settings-row__label">最近动作</p>
          <p className="settings-row__value">
            {auditPath ? `审计文件：${auditPath}` : '审计文件尚未生成'}
          </p>
        </div>
        <button
          type="button"
          className="btn btn--small"
          disabled={!auditPath}
          onClick={() => auditPath && void window.api.clipboard.writeText(auditPath)}
        >
          复制路径
        </button>
      </div>

      {audit.length === 0 ? (
        <p className="settings-row__value">还没有 agent 动作记录。</p>
      ) : (
        audit
          .slice()
          .reverse()
          .map((entry, index) => (
            <div key={`${entry.at}-${index}`} className="settings-row">
              <div>
                <p className="settings-row__label">
                  {entry.tool} {entry.ok ? '成功' : `失败（${entry.code ?? '未知'}）`}
                </p>
                <p className="settings-row__value">
                  {new Date(entry.at).toLocaleString('zh-CN')} 客户端 {entry.clientName}
                  {entry.note ? ` ${entry.note}` : ''}
                </p>
              </div>
            </div>
          ))
      )}

      {message ? <p className="settings-row__value">{message}</p> : null}
    </section>
  )
}
