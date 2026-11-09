import { describe, expect, it, vi, afterEach } from 'vitest'
import { createAgentApproval } from '../src/main/agent/approval'
import { AGENT_LIMITS } from '../src/shared/agent'

const preview = {
  action: '移入系统回收站',
  count: 2,
  paths: ['C:\\a.jpg', 'C:\\b.jpg'],
  totalBytes: 2048,
  reversible: true
}

describe('Agent 两阶段审批', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('第一次调用只登记待审批，不允许直接执行', () => {
    const approval = createAgentApproval()
    const ticket = approval.request('library_trash', 'hash-1', preview)
    expect(ticket.status).toBe('pending')
    expect(approval.consume(ticket.id, 'library_trash', 'hash-1')).toBe('required')
    expect(approval.pending()).toHaveLength(1)
  })

  it('同一工具同一参数重复申请复用同一张单，不刷屏', () => {
    const approval = createAgentApproval()
    const first = approval.request('library_trash', 'hash-1', preview)
    const second = approval.request('library_trash', 'hash-1', preview)
    expect(second.id).toBe(first.id)
    expect(approval.pending()).toHaveLength(1)
  })

  it('用户允许后可执行一次，第二次同一审批号失效', () => {
    const approval = createAgentApproval()
    const ticket = approval.request('library_trash', 'hash-1', preview)
    approval.decide(ticket.id, true)
    expect(approval.consume(ticket.id, 'library_trash', 'hash-1')).toBe('ok')
    // 单次使用：同号不能复用，否则「允许一次」就成了永久授权
    expect(approval.consume(ticket.id, 'library_trash', 'hash-1')).toBe('expired')
  })

  it('参数被换掉时审批号不生效，必须重新申请', () => {
    const approval = createAgentApproval()
    const ticket = approval.request('library_trash', 'hash-1', preview)
    approval.decide(ticket.id, true)
    expect(approval.consume(ticket.id, 'library_trash', 'hash-999')).toBe('required')
    // 换工具名同样不认
    expect(approval.consume(ticket.id, 'library_move', 'hash-1')).toBe('required')
  })

  it('用户拒绝后审批号立即作废', () => {
    const approval = createAgentApproval()
    const ticket = approval.request('library_trash', 'hash-1', preview)
    approval.decide(ticket.id, false)
    expect(approval.consume(ticket.id, 'library_trash', 'hash-1')).toBe('denied')
    expect(approval.pending()).toHaveLength(0)
  })

  it('超过有效期后审批失效，不能拿旧号执行', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-09T00:00:00Z'))
    const approval = createAgentApproval()
    const ticket = approval.request('library_trash', 'hash-1', preview)
    approval.decide(ticket.id, true)
    vi.advanceTimersByTime(AGENT_LIMITS.approvalTtlMs + 1000)
    expect(approval.consume(ticket.id, 'library_trash', 'hash-1')).toBe('expired')
  })

  it('不存在的审批号按过期处理，不能凭猜测执行', () => {
    const approval = createAgentApproval()
    expect(approval.consume('deadbeef', 'library_trash', 'hash-1')).toBe('expired')
  })
})
