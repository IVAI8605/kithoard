#!/usr/bin/env node
/**
 * Kithoard MCP server 薄壳。
 * 只做协议转换：MCP(stdio) ↔ 本机命名管道。工具实现、鉴权、限流、审批都在应用主进程，
 * 这里不复制业务逻辑，也不自己判断权限。
 *
 * 用法（在 MCP 客户端配置里）：
 *   command: node
 *   args: ["<仓库路径>/scripts/kithoard-mcp.mjs"]
 *   env:  { "KITHOARD_AGENT_TOKEN": "<设置页生成的令牌>" }
 *
 * 为什么令牌只走环境变量：MCP 客户端配置可能被截图或同步到云端，
 * 放环境变量比放命令行参数少一处泄漏面。
 */
import net from 'node:net'
import process from 'node:process'

const PIPE = '\\\\.\\pipe\\kithoard-agent-v1'
const TOKEN = process.env.KITHOARD_AGENT_TOKEN ?? ''
const SERVER_NAME = 'kithoard'
const SERVER_VERSION = '1.1.0'
const PROTOCOL_VERSION = '2024-11-05'

/** 只写参数形状，校验仍由主进程做；required 用来让客户端别漏传必填项 */
const SCHEMAS = {
  kithoard_info: { type: 'object', properties: {} },
  source_list: { type: 'object', properties: {} },
  search_assets: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '搜索关键词' },
      type: { type: 'string', enum: ['image', 'video', 'audio'], description: '素材类型' },
      page: { type: 'integer', minimum: 1, description: '页码，从 1 开始' },
      pageSize: { type: 'integer', minimum: 1, maximum: 20, description: '每页条数，最大 20' }
    },
    required: ['keyword']
  },
  get_asset: {
    type: 'object',
    properties: { assetId: { type: 'integer', description: '搜索结果里的 assetId' } },
    required: ['assetId']
  },
  download_estimate: {
    type: 'object',
    properties: { assetIds: { type: 'array', items: { type: 'integer' } } },
    required: ['assetIds']
  },
  download_enqueue: {
    type: 'object',
    properties: { assetIds: { type: 'array', items: { type: 'integer' }, maxItems: 20 } },
    required: ['assetIds']
  },
  download_control: {
    type: 'object',
    properties: {
      taskId: { type: 'string' },
      action: { type: 'string', enum: ['pause', 'resume', 'cancel', 'retry'] }
    },
    required: ['taskId', 'action']
  },
  download_list: { type: 'object', properties: {} },
  library_list: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['image', 'video', 'audio'] },
      keyword: { type: 'string' },
      page: { type: 'integer', minimum: 1 },
      pageSize: { type: 'integer', minimum: 1, maximum: 200 }
    }
  },
  library_props: {
    type: 'object',
    properties: { id: { type: 'integer' } },
    required: ['id']
  },
  favorite_list: {
    type: 'object',
    properties: { page: { type: 'integer', minimum: 1 } }
  },
  favorite_set: {
    type: 'object',
    properties: {
      assetIds: { type: 'array', items: { type: 'integer' }, maxItems: 20 },
      action: { type: 'string', enum: ['add', 'remove'] }
    },
    required: ['assetIds', 'action']
  },
  library_rename: {
    type: 'object',
    properties: { id: { type: 'integer' }, newName: { type: 'string' } },
    required: ['id', 'newName']
  },
  quarantine_list: { type: 'object', properties: {} },
  media_job: { type: 'object', properties: {} },
  library_trash: {
    type: 'object',
    properties: { ids: { type: 'array', items: { type: 'integer' }, maxItems: 20 } },
    required: ['ids'],
    description: '高风险：需要用户在本应用内逐次确认'
  },
  library_move: {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'integer' }, maxItems: 20 },
      targetDir: { type: 'string', description: '目标目录绝对路径' }
    },
    required: ['ids', 'targetDir'],
    description: '高风险：需要用户在本应用内逐次确认'
  },
  quarantine_restore: {
    type: 'object',
    properties: { id: { type: 'integer' } },
    required: ['id'],
    description: '高风险：需要用户在本应用内逐次确认'
  }
}

let pendingApproval = ''

/** 与 CLI 相同的管道调用；审批号在进程内记住一次，便于紧接着重试同一动作 */
function send(request) {
  return new Promise((resolve) => {
    const socket = net.connect(PIPE)
    let buffer = ''
    let settled = false
    const done = (payload) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(payload)
    }

    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const index = buffer.indexOf('\n')
      if (index < 0) return
      try {
        done(JSON.parse(buffer.slice(0, index)))
      } catch {
        done({ ok: false, error: { code: 'E_UNKNOWN', message: '响应不是合法 JSON' } })
      }
    })
    socket.on('error', (error) => {
      if (error.code === 'ENOENT') {
        done({
          ok: false,
          error: {
            code: 'E_APP_NOT_READY',
            message: '找不到命名管道：应用未运行，或设置里没有开启 Agent 接入'
          }
        })
        return
      }
      done({ ok: false, error: { code: 'E_UNKNOWN', message: error.message } })
    })
    socket.setTimeout(60000, () => {
      done({ ok: false, error: { code: 'E_UNKNOWN', message: '请求超时' } })
    })
  })
}

async function callTool(name, args) {
  const request = { id: String(Date.now()), token: TOKEN, tool: name, args: args ?? {} }
  if (pendingApproval) {
    request.approvalId = pendingApproval
    pendingApproval = ''
  }
  const result = await send(request)
  if (result.ok) {
    return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] }
  }
  const error = result.error ?? { code: 'E_UNKNOWN', message: '未知错误' }
  if (error.code === 'E_APPROVAL_REQUIRED' && error.detail) {
    // 把审批号留在进程内并写清楚让人去确认，不把它当成普通失败
    pendingApproval = error.detail
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            `E_APPROVAL_REQUIRED：该操作需要用户在本应用内确认。\n` +
            `审批号：${error.detail}\n` +
            '请提示用户打开 Kithoard 并选择「允许一次」，然后重新调用同一工具与同一参数即可继续。'
        }
      ]
    }
  }
  return {
    isError: true,
    content: [{ type: 'text', text: `${error.code}: ${error.message}` }]
  }
}

async function handle(message) {
  const { id, method, params } = message

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
      }
    }
  }

  if (method === 'tools/list') {
    const result = await send({ id: 'list', token: TOKEN, tool: 'kithoard_info' })
    if (!result.ok) {
      throw new Error(result.error?.message ?? '无法读取工具清单')
    }
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: result.data.tools.map((tool) => ({
          name: tool.name,
          description: `${tool.summary}（作用域 ${tool.scope}${tool.approval ? '，需人工确认' : ''}）`,
          inputSchema: SCHEMAS[tool.name] ?? { type: 'object', properties: {} }
        }))
      }
    }
  }

  if (method === 'tools/call') {
    const name = params?.name
    if (typeof name !== 'string') throw new Error('缺少工具名')
    return { jsonrpc: '2.0', id, result: await callTool(name, params?.arguments) }
  }

  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }

  // 通知类消息没有 id，不需要回包
  if (id === undefined) return null

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `不支持的方法：${method}` }
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    index = buffer.indexOf('\n')
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '解析失败' } })}\n`
      )
      continue
    }
    void handle(message)
      .then((response) => {
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
      })
      .catch((error) => {
        // 单个调用失败不能拖垮整个 server：按 JSON-RPC 错误回包
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id ?? null,
            error: { code: -32603, message: error instanceof Error ? error.message : String(error) }
          })}\n`
        )
      })
  }
})

process.stdin.on('end', () => process.exit(0))
