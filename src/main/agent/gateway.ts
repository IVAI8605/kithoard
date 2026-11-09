import net from 'node:net'
import type {
  AgentApprovalTicket,
  AgentAuditEntry,
  AgentClientRecord,
  AgentRequest,
  AgentScope,
  AgentStatus
} from '@shared/agent'
import {
  AGENT_LIMITS,
  AGENT_PIPE_NAME,
  AGENT_PROTOCOL_VERSION
} from '@shared/agent'
import { CHANNELS } from '@shared/channels'
import { fail, isAppError, makeError, ok, type Envelope } from '@shared/errors'
import { log } from '../log'
import { getPlainSetting, setPlainSetting } from '../settings'
import { TokenBucket } from '../sources/rate-limit'
import { createAgentApproval } from './approval'
import { createAgentAudit } from './audit'
import { createAgentAuth } from './auth'
import { createAgentTools, type AgentServices } from './tools'

const ENABLED_KEY = 'agent.enabled'

export interface AgentGateway {
  /** 按当前开关决定是否开始监听；应用启动时调用一次 */
  sync(): void
  stop(): void
  status(): AgentStatus
  setEnabled(enabled: boolean): AgentStatus
  /** 生成客户端令牌；明文只在这里返回一次 */
  issueToken(name: string, scopes: AgentScope[]): { token: string; client: AgentClientRecord }
  revoke(clientId: string): AgentStatus
  revokeAll(): AgentStatus
  /** 用户对某次审批点「允许一次」或「拒绝」 */
  decide(approvalId: string, allow: boolean): AgentStatus
  pendingApprovals(): AgentApprovalTicket[]
  auditRecent(limit: number): AgentAuditEntry[]
  auditPath(): string
}

/**
 * 命名管道网关。
 * 为什么默认关闭时仍然监听：客户端需要拿到可读的 E_AGENT_DISABLED，
 * 否则只会看到「管道不存在」这种无法区分「没开」和「应用没运行」的错误。
 * 关闭状态下除版本探测外一律拒绝，且不接受任何无令牌请求。
 */
export function createAgentGateway(deps: {
  services: AgentServices
  appVersion: string
  userDataDir: string
  /** 把审批请求推给界面；审批框必须由应用自己弹，不能交给 agent */
  notify: (channel: string, payload: unknown) => void
}): AgentGateway {
  // 令牌存进 settings 的普通键，不走 safeStorage：哈希本身不是秘密，
  // 但明文令牌只在签发时出现一次，库里拿不到可用于连接的凭据。
  const auth = createAgentAuth({ read: getPlainSetting, write: setPlainSetting })
  const audit = createAgentAudit(deps.userDataDir)
  const approval = createAgentApproval()
  const tools = createAgentTools({
    services: deps.services,
    appVersion: deps.appVersion
  })

  let server: net.Server | null = null
  let running = false
  const sockets = new Set<net.Socket>()

  function isEnabled(): boolean {
    return getPlainSetting(ENABLED_KEY) === '1'
  }

  function status(): AgentStatus {
    const clients = auth.list()
    const scopes = [...new Set(clients.flatMap((client) => client.scopes))]
    return {
      enabled: isEnabled(),
      running,
      clients,
      scopes,
      pendingApprovals: approval.pending(),
      pipeName: AGENT_PIPE_NAME,
      version: AGENT_PROTOCOL_VERSION,
      limits: AGENT_LIMITS
    }
  }

  function writeLine(socket: net.Socket, payload: unknown): void {
    if (socket.destroyed) return
    socket.write(`${JSON.stringify(payload)}\n`)
  }

  /** 单条请求处理：令牌 → 限流 → 作用域 → 工具 → 审计，顺序不能换 */
  async function handleLine(socket: net.Socket, line: string, bucket: TokenBucket): Promise<void> {
    let request: AgentRequest
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not object')
      request = parsed as AgentRequest
    } catch {
      writeLine(socket, fail('E_INVALID_ARG', 'json'))
      return
    }

    const requestId = typeof request.id === 'string' ? request.id : ''
    function reply(body: Envelope<unknown>): void {
      writeLine(socket, { id: requestId, ...body })
    }

    if (!isEnabled()) {
      reply(fail('E_AGENT_DISABLED'))
      return
    }
    if (!bucket.take()) {
      // 限流也写审计：配额打满往往意味着客户端在循环调用，需要留痕
      audit.write({
        at: Date.now(),
        clientId: '-',
        clientName: '-',
        tool: String(request.tool ?? ''),
        scope: '-',
        ok: false,
        code: 'E_QUOTA_EXCEEDED',
        argsHash: audit.argsHash(request.args),
        note: 'rate limited'
      })
      reply(fail('E_QUOTA_EXCEEDED'))
      return
    }

    const client = auth.verify(request.token)
    if (!client) {
      reply(fail('E_UNAUTHORIZED'))
      return
    }

    const tool = typeof request.tool === 'string' ? tools.get(request.tool) : undefined
    if (!tool) {
      audit.write({
        at: Date.now(),
        clientId: client.id,
        clientName: client.name,
        tool: String(request.tool ?? ''),
        scope: '-',
        ok: false,
        code: 'E_INVALID_ARG',
        argsHash: audit.argsHash(request.args),
        note: 'unknown tool'
      })
      reply(fail('E_INVALID_ARG', 'tool'))
      return
    }

    // destructive 永不直接授予：要么走两阶段审批，要么明确拒绝。
    // 审批必须先于作用域检查——destructive 本来就不在令牌作用域里。
    if (tool.approval) {
      const argsHash = audit.argsHash(request.args)
      const approvalId = typeof request.approvalId === 'string' ? request.approvalId : ''
      if (!approvalId) {
        if (!tool.preview) {
          reply(fail('E_UNKNOWN', 'approval preview missing'))
          return
        }
        try {
          const preview = await tool.preview(request.args)
          const ticket = approval.request(tool.name, argsHash, preview)
          audit.write({
            at: Date.now(),
            clientId: client.id,
            clientName: client.name,
            tool: tool.name,
            scope: tool.scope,
            ok: false,
            code: 'E_APPROVAL_REQUIRED',
            argsHash,
            note: `approval ${ticket.id}`
          })
          // 推给界面弹框；agent 只能等，不能自己批准
          deps.notify(CHANNELS.agentApproval, ticket)
          reply(fail('E_APPROVAL_REQUIRED', ticket.id))
        } catch (error) {
          const appError = isAppError(error) ? error : makeError('E_UNKNOWN', String(error))
          reply({ ok: false, error: appError })
        }
        return
      }

      const verdict = approval.consume(approvalId, tool.name, argsHash)
      if (verdict !== 'ok') {
        const code =
          verdict === 'denied'
            ? 'E_APPROVAL_DENIED'
            : verdict === 'expired'
              ? 'E_APPROVAL_EXPIRED'
              : 'E_APPROVAL_REQUIRED'
        audit.write({
          at: Date.now(),
          clientId: client.id,
          clientName: client.name,
          tool: tool.name,
          scope: tool.scope,
          ok: false,
          code,
          argsHash,
          note: `approval ${approvalId} ${verdict}`
        })
        reply(fail(code, verdict))
        return
      }
    } else if (!client.scopes.includes(tool.scope as AgentScope)) {
      audit.write({
        at: Date.now(),
        clientId: client.id,
        clientName: client.name,
        tool: tool.name,
        scope: tool.scope,
        ok: false,
        code: 'E_SCOPE_DENIED',
        argsHash: audit.argsHash(request.args)
      })
      reply(fail('E_SCOPE_DENIED', tool.scope))
      return
    }

    try {
      const result = await tool.handler(request.args)
      audit.write({
        at: Date.now(),
        clientId: client.id,
        clientName: client.name,
        tool: tool.name,
        scope: tool.scope,
        ok: true,
        argsHash: audit.argsHash(request.args)
      })
      reply(ok(result))
    } catch (error) {
      const appError = isAppError(error) ? error : makeError('E_UNKNOWN', String(error))
      audit.write({
        at: Date.now(),
        clientId: client.id,
        clientName: client.name,
        tool: tool.name,
        scope: tool.scope,
        ok: false,
        code: appError.code,
        argsHash: audit.argsHash(request.args)
      })
      reply({ ok: false, error: appError })
    }
  }

  function startServer(): void {
    if (server) return
    server = net.createServer((socket) => {
      sockets.add(socket)
      const bucket = new TokenBucket(AGENT_LIMITS.perMinute)
      let buffer = ''
      // 空闲超时避免僵尸连接一直占着配额
      socket.setTimeout(AGENT_LIMITS.idleTimeoutMs)

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        // 超长请求直接断开：正常工具参数远小于这个量级，超了基本是恶意或写错协议
        if (buffer.length > AGENT_LIMITS.maxRequestBytes) {
          log.warn('agent request too large, closing connection')
          socket.destroy()
          return
        }
        let index = buffer.indexOf('\n')
        while (index >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (line) void handleLine(socket, line, bucket)
          index = buffer.indexOf('\n')
        }
      })

      socket.on('timeout', () => socket.destroy())
      socket.on('error', (error) => {
        log.warn(`agent socket error: ${error.message}`)
      })
      socket.on('close', () => sockets.delete(socket))
    })

    server.on('error', (error) => {
      running = false
      // 管道已被另一个实例占用时只记日志，不阻断应用启动
      log.warn(`agent gateway listen failed: ${error.message}`)
    })

    server.listen(AGENT_PIPE_NAME, () => {
      running = true
      log.info(`agent gateway listening on ${AGENT_PIPE_NAME}`)
    })
  }

  function stopServer(): void {
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    if (server) {
      server.close()
      server = null
    }
    running = false
  }

  return {
    sync() {
      if (isEnabled()) startServer()
      else stopServer()
    },

    stop: stopServer,

    status,

    setEnabled(enabled) {
      setPlainSetting(ENABLED_KEY, enabled ? '1' : '0')
      // 关闭时立即断开所有连接：不能等下一次请求才发现被关掉
      if (enabled) startServer()
      else stopServer()
      log.info(`agent gateway ${enabled ? 'enabled' : 'disabled'}`)
      return status()
    },

    issueToken(name, scopes) {
      return auth.issue(name, scopes)
    },

    revoke(clientId) {
      auth.revoke(clientId)
      return status()
    },

    revokeAll() {
      auth.revokeAll()
      return status()
    },

    decide(approvalId, allow) {
      // 只改审批状态，不执行动作：真正的执行由 agent 拿审批号再次调用来完成，
      // 这样「谁批准」和「谁执行」在审计里是两条可对账的记录。
      approval.decide(approvalId, allow)
      return status()
    },

    pendingApprovals() {
      return approval.pending()
    },

    auditRecent: (limit) => audit.recent(limit),
    auditPath: () => audit.filePath()
  }
}
