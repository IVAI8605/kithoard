#!/usr/bin/env node
/**
 * Kithoard Agent CLI 薄壳。
 * 只做三件事：连命名管道、发一条 JSON、把结果显示出来。
 * 所有校验与业务都在应用主进程里，这里不复制任何规则——否则 CLI 与界面会两套口径。
 *
 * 用法：
 *   kithoard-agent tools                      列出工具
 *   kithoard-agent info                       接口版本、限额与源状态
 *   kithoard-agent call library_list '{"page":1,"pageSize":5}'
 *   kithoard-agent call library_trash '{"ids":[1]}' --approval <审批号>
 *
 * 令牌从环境变量 KITHOARD_AGENT_TOKEN 读取，不接受命令行参数：
 * 命令行会进 shell 历史与进程列表，令牌不该出现在那里。
 */
import net from 'node:net'
import process from 'node:process'

const PIPE = '\\\\.\\pipe\\kithoard-agent-v1'
const TOKEN_ENV = 'KITHOARD_AGENT_TOKEN'

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

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
      // 管道不存在与「应用没开 Agent」是两件事，必须分开告诉用户
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
    socket.setTimeout(15000, () => {
      done({ ok: false, error: { code: 'E_UNKNOWN', message: '请求超时' } })
    })
  })
}

function parseArgs(argv) {
  const args = [...argv]
  let approvalId = ''
  const approvalIndex = args.indexOf('--approval')
  if (approvalIndex >= 0) {
    approvalId = args[approvalIndex + 1] ?? ''
    args.splice(approvalIndex, 2)
  }
  return { args, approvalId }
}

async function main() {
  const { args, approvalId } = parseArgs(process.argv.slice(2))
  const [command, ...rest] = args
  const token = process.env[TOKEN_ENV] ?? ''

  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(
      [
        'Kithoard Agent CLI',
        '',
        '  tools                                  列出可用工具',
        '  info                                   接口版本、限额与工具清单',
        '  call <tool> [json]                     调用工具，json 省略时视为 {}',
        '  call <tool> <json> --approval <id>     高风险动作：拿到审批号后重试',
        '',
        `令牌通过环境变量 ${TOKEN_ENV} 提供（在设置页 → Agent 接入里生成）。`
      ].join('\n') + '\n'
    )
    return
  }

  if (!token) fail(`缺少令牌：请先设置环境变量 ${TOKEN_ENV}`)

  if (command === 'tools' || command === 'info') {
    const result = await send({ id: '1', token, tool: 'kithoard_info' })
    if (!result.ok) return reportError(result)
    if (command === 'tools') {
      for (const tool of result.data.tools) {
        process.stdout.write(
          `${tool.name.padEnd(20)} ${tool.scope.padEnd(12)} ${tool.risk}  ${tool.summary}\n`
        )
      }
      return
    }
    process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`)
    return
  }

  if (command === 'call') {
    const tool = rest[0]
    if (!tool) fail('用法：kithoard-agent call <tool> [json]')
    let parsed = {}
    if (rest[1]) {
      try {
        parsed = JSON.parse(rest[1])
      } catch {
        fail('第二个参数必须是合法 JSON')
      }
    }
    const request = { id: '1', token, tool, args: parsed }
    if (approvalId) request.approvalId = approvalId
    const result = await send(request)
    if (!result.ok) return reportError(result)
    process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`)
    return
  }

  fail(`未知命令：${command}`)
}

function reportError(result) {
  const error = result.error ?? { code: 'E_UNKNOWN', message: '未知错误' }
  process.stderr.write(`${error.code}: ${error.message}\n`)
  // 需要审批时把审批号原样打出来，用户拿它去界面确认后再重试
  if (error.code === 'E_APPROVAL_REQUIRED' && error.detail) {
    process.stderr.write(`审批号：${error.detail}\n`)
    process.stderr.write('请在本应用弹出的确认框里选择「允许一次」，然后带 --approval 重试。\n')
  }
  process.exit(2)
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
