import crypto from 'node:crypto'
import type { AgentApprovalPreview, AgentApprovalTicket } from '@shared/agent'
import { AGENT_LIMITS } from '@shared/agent'

type Status = 'pending' | 'allowed' | 'denied' | 'used'

interface Ticket extends AgentApprovalTicket {
  status: Status
}

export type ApproveResult = 'ok' | 'required' | 'denied' | 'expired'

export interface AgentApproval {
  /**
   * 登记一次待审批动作，返回审批号与影响预览。
   * 同一工具同一参数重复发起时复用已有待审批单，避免 agent 重试把弹窗刷屏。
   */
  request(tool: string, argsHash: string, preview: AgentApprovalPreview): Ticket
  /** 用户在本应用内点「允许一次」或「拒绝」 */
  decide(id: string, allow: boolean): Ticket | null
  /** 第二次调用时核销：工具名、参数哈希、状态、时效必须全部匹配 */
  consume(id: string, tool: string, argsHash: string): ApproveResult
  /** 待审批列表，供界面弹窗 */
  pending(): Ticket[]
  get(id: string): Ticket | null
}

export function createAgentApproval(): AgentApproval {
  const tickets = new Map<string, Ticket>()

  function prune(now: number): void {
    for (const [id, ticket] of tickets) {
      // 过期的直接标记而不是删掉：agent 回来问时才能告诉它「过期」而不是「不存在」
      if (ticket.status === 'pending' && now - ticket.createdAt > AGENT_LIMITS.approvalTtlMs) {
        ticket.status = 'denied'
        tickets.delete(id)
      }
    }
  }

  return {
    request(tool, argsHash, preview) {
      const now = Date.now()
      prune(now)
      for (const ticket of tickets.values()) {
        if (
          ticket.status === 'pending' &&
          ticket.tool === tool &&
          ticket.argsHash === argsHash &&
          now - ticket.createdAt <= AGENT_LIMITS.approvalTtlMs
        ) {
          return ticket
        }
      }
      const ticket: Ticket = {
        id: crypto.randomBytes(8).toString('hex'),
        tool,
        argsHash,
        preview,
        createdAt: now,
        expiresAt: now + AGENT_LIMITS.approvalTtlMs,
        status: 'pending'
      }
      tickets.set(ticket.id, ticket)
      return ticket
    },

    decide(id, allow) {
      const ticket = tickets.get(id)
      if (!ticket) return null
      if (ticket.status !== 'pending') return ticket
      ticket.status = allow ? 'allowed' : 'denied'
      // 拒绝也要留着记录：agent 回来时必须拿到「用户拒绝了」而不是「过期了」，
      // 否则它会按过期语义重新申请，等于绕过用户已经做出的决定。
      return ticket
    },

    consume(id, tool, argsHash) {
      const now = Date.now()
      const ticket = tickets.get(id)
      if (!ticket) return 'expired'
      if (now > ticket.expiresAt) {
        tickets.delete(id)
        return 'expired'
      }
      // 参数哈希必须一致：防止批了 3 条却执行 300 条
      if (ticket.tool !== tool || ticket.argsHash !== argsHash) return 'required'
      if (ticket.status === 'denied' || ticket.status === 'used') {
        // 读到明确结论后即可清理，避免被拒绝的单据长期占内存
        tickets.delete(id)
        return 'denied'
      }
      if (ticket.status !== 'allowed') return 'required'
      ticket.status = 'used'
      tickets.delete(id)
      return 'ok'
    },

    pending() {
      prune(Date.now())
      return [...tickets.values()].filter((ticket) => ticket.status === 'pending')
    },

    get(id) {
      return tickets.get(id) ?? null
    }
  }
}
