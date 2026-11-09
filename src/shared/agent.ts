/**
 * V1.1 Agent 接入面：主进程网关与外部客户端共用的协议常量与类型。
 * 这里不 import 任何 Node 模块，渲染层与主进程都能安全引用。
 */

/** 接口版本：任何破坏性字段变更都要递增，客户端据此判断是否需要升级 */
export const AGENT_PROTOCOL_VERSION = 1

/** 命名管道只允许本机当前用户访问，不开网络端口（§6.5 安全基线） */
export const AGENT_PIPE_NAME = '\\\\.\\pipe\\kithoard-agent-v1'

/** 可直接授予的作用域；destructive 永不直接授予，必须逐次人工审批 */
export const AGENT_SCOPES = ['read', 'acquire', 'organize'] as const
export type AgentScope = (typeof AGENT_SCOPES)[number]

/** R0 只读、R1 可逆写、R2 破坏性写（需审批）；R3 管理/秘密不对 agent 开放 */
export type AgentRisk = 'R0' | 'R1' | 'R2'

export interface AgentLimits {
  /** 单连接每分钟请求上限；文档与 kithoard_info 返回同一个数字 */
  perMinute: number
  /** 单次批量操作上限，与界面共用 MAX_ENQUEUE_ASSETS 的口径 */
  batchMax: number
  /** 单条请求最大字节数，防止一次灌爆内存 */
  maxRequestBytes: number
  /** 连接空闲超时，到点断开，避免僵尸连接一直占着配额 */
  idleTimeoutMs: number
  /** 审批有效期：超时作废，必须重新申请 */
  approvalTtlMs: number
}

export const AGENT_LIMITS: AgentLimits = {
  perMinute: 120,
  batchMax: 20,
  maxRequestBytes: 64 * 1024,
  idleTimeoutMs: 10 * 60 * 1000,
  approvalTtlMs: 120 * 1000
}

/** 客户端发来的一条请求；一行一条 JSON（NDJSON） */
export interface AgentRequest {
  /** 客户端生成的请求号，响应原样带回，便于并发调用配对 */
  id: string
  /** 每次请求都带令牌：不依赖长连接状态，断开重连不用重新握手 */
  token: string
  tool: string
  args?: unknown
  /** 高风险工具第二次调用时必须带上第一次返回的审批号 */
  approvalId?: string
}

/** 工具清单条目，供 kithoard_info 与文档共用一份口径 */
export interface AgentToolInfo {
  name: string
  scope: AgentScope | 'destructive'
  risk: AgentRisk
  /** 是否需要人工审批；只有 R2 为 true */
  approval: boolean
  summary: string
}

/** 客户端记录：只存令牌哈希，明文只在生成时显示一次 */
export interface AgentClientRecord {
  /** 令牌哈希前 8 位，用于界面识别与吊销 */
  id: string
  name: string
  scopes: AgentScope[]
  createdAt: number
  lastSeenAt: number | null
}

/** 审计条目：写 JSONL，全量记录 agent 做过的每个动作 */
export interface AgentAuditEntry {
  at: number
  clientId: string
  clientName: string
  tool: string
  scope: string
  ok: boolean
  /** 失败时的错误码 */
  code?: string
  /** 参数摘要（sha256 前 16 位），用于对账但不落原文 */
  argsHash: string
  /** 可读补充，例如审批号或批量条数 */
  note?: string
}

/** 网关运行状态，设置页与 kithoard_info 共用 */
export interface AgentStatus {
  enabled: boolean
  running: boolean
  clients: AgentClientRecord[]
  /** 当前令牌授予的作用域；未生成令牌时为空数组 */
  scopes: AgentScope[]
  pipeName: string
  version: number
  limits: AgentLimits
}
