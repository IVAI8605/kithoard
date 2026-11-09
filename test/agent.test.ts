import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAgentAuth, type AgentAuthStore } from '../src/main/agent/auth'
import { createAgentAudit } from '../src/main/agent/audit'
import { createAgentTools, type AgentServices } from '../src/main/agent/tools'
import { AGENT_LIMITS, AGENT_PROTOCOL_VERSION } from '../src/shared/agent'
import type { AppError } from '../src/shared/errors'

/** 内存版设置存储：令牌逻辑本身不该依赖 Electron 或数据库 */
function memoryStore(): AgentAuthStore & { dump(): Map<string, string> } {
  const map = new Map<string, string>()
  return {
    read: (key) => map.get(key) ?? null,
    write: (key, value) => {
      map.set(key, value)
    },
    dump: () => map
  }
}

describe('Agent 令牌', () => {
  it('签发的令牌能校验通过，且库里只留哈希', () => {
    const store = memoryStore()
    const auth = createAgentAuth(store)
    const { token, client } = auth.issue('测试客户端', ['read', 'acquire'])

    expect(token.length).toBeGreaterThan(20)
    expect(auth.verify(token)?.id).toBe(client.id)

    const raw = store.read('agent.tokens') ?? ''
    expect(raw).not.toContain(token)
    expect(raw).toContain(client.id)
  })

  it('伪造令牌、过短令牌、空令牌一律拒绝', () => {
    const auth = createAgentAuth(memoryStore())
    auth.issue('x', ['read'])
    expect(auth.verify('not-a-real-token-value')).toBeNull()
    expect(auth.verify('short')).toBeNull()
    expect(auth.verify('')).toBeNull()
    expect(auth.verify(undefined as unknown as string)).toBeNull()
  })

  it('吊销后同一令牌立即失效，不存在的客户端返回 false', () => {
    const auth = createAgentAuth(memoryStore())
    const { token, client } = auth.issue('x', ['read'])
    expect(auth.revoke(client.id)).toBe(true)
    expect(auth.verify(token)).toBeNull()
    expect(auth.revoke('deadbeef')).toBe(false)
  })

  it('destructive 不会写进令牌作用域', () => {
    const auth = createAgentAuth(memoryStore())
    const { client } = auth.issue('x', ['read', 'destructive'] as never)
    expect(client.scopes).toEqual(['read'])
  })

  it('revokeAll 清空全部客户端', () => {
    const auth = createAgentAuth(memoryStore())
    auth.issue('a', ['read'])
    auth.issue('b', ['read'])
    expect(auth.list()).toHaveLength(2)
    auth.revokeAll()
    expect(auth.list()).toHaveLength(0)
  })
})

describe('Agent 工具表', () => {
  // 只实现测试用得到的方法；其余留空，避免为了测试给 service 加接口
  const services = {
    sources: { list: () => [{ id: 'pixabay', enabled: true }] },
    search: { searchGrouped: async () => ({ groups: [] }) },
    detail: { get: () => ({ id: 1 }) },
    download: {
      estimate: () => ({ count: 0, bytes: null }),
      enqueue: () => ({ taskIds: [] }),
      pause: async () => ({ ok: true }),
      resume: () => ({ ok: true }),
      cancel: async () => ({ ok: true }),
      retry: () => ({ ok: true }),
      list: () => []
    },
    library: { list: () => ({ items: [], total: 0 }), props: () => ({}) },
    favorite: {
      list: () => ({ items: [], total: 0 }),
      add: async () => ({ ok: true, added: 0 }),
      remove: async () => ({ ok: true, removed: 0 })
    },
    quarantine: { list: () => [] },
    media: { list: () => [] }
  } as unknown as AgentServices

  const tools = createAgentTools({ services, appVersion: '1.1.0' })

  it('kithoard_info 返回协议版本、限额与完整工具清单', async () => {
    const info = (await tools.get('kithoard_info')?.handler(undefined)) as {
      protocolVersion: number
      appVersion: string
      limits: typeof AGENT_LIMITS
      tools: { name: string }[]
    }
    expect(info.protocolVersion).toBe(AGENT_PROTOCOL_VERSION)
    expect(info.appVersion).toBe('1.1.0')
    expect(info.limits.batchMax).toBe(AGENT_LIMITS.batchMax)
    // 清单必须包含 kithoard_info 自身，否则客户端无法发现自己的能力面
    expect(info.tools.map((t) => t.name)).toContain('kithoard_info')
    expect(info.tools.length).toBe(tools.size)
  })

  it('不暴露管理类通道：没有设置写入、备份导入、清空数据或内置浏览', () => {
    const names = [...tools.keys()]
    for (const forbidden of ['settings_set', 'settings_restore', 'settings_reset', 'browser_open']) {
      expect(names).not.toContain(forbidden)
    }
  })

  it('批量超过上限返回 E_BATCH_TOO_LARGE，而不是笼统参数错误', async () => {
    const ids = Array.from({ length: AGENT_LIMITS.batchMax + 1 }, (_, i) => i + 1)
    try {
      await tools.get('download_enqueue')?.handler({ assetIds: ids })
      throw new Error('should throw')
    } catch (error) {
      expect((error as AppError).code).toBe('E_BATCH_TOO_LARGE')
    }
  })

  it('非法 id 与非法 action 被拒绝', async () => {
    for (const bad of [{ assetIds: ['1'] }, { assetIds: [0] }, { assetIds: [1.5] }, {}]) {
      // enqueue 是同步工具：包成 async 才能用 rejects 断言，否则同步抛错会在断言前冒出
      await expect(async () => tools.get('download_enqueue')?.handler(bad)).rejects.toMatchObject({
        code: 'E_INVALID_ARG'
      })
    }
    await expect(
      tools.get('download_control')?.handler({ taskId: 't1', action: 'explode' })
    ).rejects.toMatchObject({ code: 'E_INVALID_ARG' })
  })

  it('搜索结果统一补 assetId，其余字段原样透传', async () => {
    const withItem = createAgentTools({
      services: {
        ...services,
        search: {
          searchGrouped: async () => ({
            groups: [{ sourceId: 'pixabay', items: [{ id: 42, title: '图' }] }]
          })
        }
      } as unknown as AgentServices,
      appVersion: '1.1.0'
    })
    const result = (await withItem.get('search_assets')?.handler({ keyword: 'x' })) as {
      groups: { items: { id: number; assetId: number; title: string }[] }[]
    }
    expect(result.groups[0].items[0]).toMatchObject({ id: 42, assetId: 42, title: '图' })
  })
})

describe('Agent 审计', () => {
  it('写入后能按时间读回，参数只留哈希不落原文', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithoard-agent-audit-'))
    const audit = createAgentAudit(dir)
    const args = { assetIds: [1, 2, 3] }
    const hash = audit.argsHash(args)
    expect(hash).toHaveLength(16)

    audit.write({
      at: 1700000000000,
      clientId: 'abcd1234',
      clientName: '测试',
      tool: 'download_enqueue',
      scope: 'acquire',
      ok: true,
      argsHash: hash
    })

    const entries = audit.recent(10)
    expect(entries).toHaveLength(1)
    expect(entries[0].argsHash).toBe(hash)
    expect(JSON.stringify(entries[0])).not.toContain('[1,2,3]')
    expect(fs.readFileSync(audit.filePath(), 'utf8')).not.toContain('download_enqueue":{"')
  })

  it('文件不存在时返回空数组而不是抛错', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithoard-agent-audit-'))
    expect(createAgentAudit(dir).recent(10)).toEqual([])
  })

  it('单行损坏不影响其余记录', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithoard-agent-audit-'))
    const audit = createAgentAudit(dir)
    const entry = {
      at: 1,
      clientId: 'a',
      clientName: 'n',
      tool: 't',
      scope: 'read',
      ok: true,
      argsHash: 'h'
    }
    fs.writeFileSync(audit.filePath(), `${JSON.stringify(entry)}\n{坏行\n${JSON.stringify(entry)}\n`)
    expect(audit.recent(10)).toHaveLength(2)
  })
})
