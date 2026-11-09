import type {
  AgentApprovalPreview,
  AgentRisk,
  AgentScope,
  AgentToolInfo,
  AgentLimits
} from '@shared/agent'
import { AGENT_LIMITS, AGENT_PROTOCOL_VERSION, AGENT_PIPE_NAME } from '@shared/agent'
import { makeError } from '@shared/errors'
import type { DownloadService } from '../services/download'
import type { FavoriteService } from '../services/favorite'
import type { LibraryService } from '../services/library'
import type { QuarantineService } from '../services/quarantine'
import type { SearchService } from '../services/search'
import type { SourceService } from '../services/sources'
import type { MediaService } from '../services/media'
import type { DetailService } from '../services/detail'

/**
 * 工具层只做三件事：作用域判定在外层、这里是「参数范围与批量上限」和「调既有 service」。
 * 绝不在工具里重写业务规则——校验、状态机、许可判定都在 service 内，
 * 否则界面与 agent 会出现两套口径（§6.2 实现约定）。
 */
export interface AgentServices {
  sources: SourceService
  search: SearchService
  detail: DetailService
  download: DownloadService
  library: LibraryService
  favorite: FavoriteService
  quarantine: QuarantineService
  media: MediaService
}

export interface AgentTool {
  name: string
  scope: AgentScope | 'destructive'
  risk: AgentRisk
  approval: boolean
  summary: string
  handler: (args: unknown) => Promise<unknown> | unknown
  /**
   * 高风险工具必须提供：主进程据此算影响预览，交给应用内审批框。
   * agent 自己描述的影响不算数——它说什么就确认什么，等于没有确认。
   */
  preview?: (args: unknown) => Promise<AgentApprovalPreview> | AgentApprovalPreview
}

const MAX_BATCH = AGENT_LIMITS.batchMax

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** 只接受 id 数组，且对批量超限给出专用错误码，便于 agent 拆分而不是盲重试 */
function readIds(value: unknown, field = 'assetIds'): number[] {
  if (!Array.isArray(value)) throw makeError('E_INVALID_ARG', field)
  const ids = value.filter((item): item is number => Number.isInteger(item) && (item as number) > 0)
  if (ids.length !== value.length) throw makeError('E_INVALID_ARG', field)
  if (ids.length > MAX_BATCH) throw makeError('E_BATCH_TOO_LARGE', field)
  return ids
}

export function createAgentTools(deps: {
  services: AgentServices
  appVersion: string
}): Map<string, AgentTool> {
  const { services } = deps
  const tools: AgentTool[] = [
    {
      name: 'source_list',
      scope: 'read',
      risk: 'R0',
      approval: false,
      summary: '素材源列表与启用状态',
      handler: () => services.sources.list()
    },
    {
      name: 'search_assets',
      scope: 'read',
      risk: 'R0',
      approval: false,
      summary: '按关键词搜索素材，按源分组返回，单页最多 20 条',
      handler: async (args) => {
        const result = await services.search.searchGrouped(args)
        // agent 侧统一用 assetId：其余字段原样透传，避免这里维护一份字段清单导致漂移
        return {
          groups: result.groups.map((group) => ({
            ...group,
            items: group.items.map((item) => ({ ...item, assetId: item.id }))
          }))
        }
      }
    },
    {
      name: 'get_asset',
      scope: 'read',
      risk: 'R0',
      approval: false,
      summary: '素材详情：许可、署名与风险提示',
      handler: (args) => services.detail.get(args)
    },
    {
      name: 'download_estimate',
      scope: 'read',
      risk: 'R0',
      approval: false,
      summary: '下载前估算数量与字节数；未知大小返回 null，不猜数字',
      handler: (args) => {
        const record = asRecord(args)
        const ids = readIds(record.assetIds)
        return services.download.estimate({ assetIds: ids })
      }
    },
    {
      name: 'download_enqueue',
      scope: 'acquire',
      risk: 'R1',
      approval: false,
      summary: '提交下载任务，只接受 assetId，单批最多 20 条',
      handler: (args) => {
        const record = asRecord(args)
        const ids = readIds(record.assetIds)
        return services.download.enqueue({ assetIds: ids })
      }
    },
    {
      name: 'download_control',
      scope: 'acquire',
      risk: 'R1',
      approval: false,
      summary: '暂停 / 继续 / 取消 / 重试单个下载任务',
      handler: async (args) => {
        const record = asRecord(args)
        const taskId = record.taskId
        if (typeof taskId !== 'string' || !taskId) throw makeError('E_INVALID_ARG', 'taskId')
        const action = record.action
        if (action === 'pause') return services.download.pause({ taskId })
        if (action === 'resume') return services.download.resume({ taskId })
        if (action === 'cancel') return services.download.cancel({ taskId })
        if (action === 'retry') return services.download.retry({ taskId })
        throw makeError('E_INVALID_ARG', 'action')
      }
    },
    {
      name: 'download_list',
      scope: 'read',
      risk: 'R0',
      approval: false,
      summary: '下载任务列表与进度（轮询入口）',
      handler: () => services.download.list()
    },
    {
      name: 'library_list',
      scope: 'read',
      risk: 'R0',
      approval: false,
      summary: '本地素材分页列表，支持类型与关键词筛选',
      handler: (args) => services.library.list(args ?? {})
    },
    {
      name: 'library_props',
      scope: 'read',
      risk: 'R0',
      approval: false,
      summary: '单个本地素材的绝对路径、大小与时间',
      handler: (args) => services.library.props(args)
    },
    {
      name: 'favorite_list',
      scope: 'read',
      risk: 'R0',
      approval: false,
      summary: '收藏夹分页列表',
      handler: (args) => services.favorite.list(args ?? {})
    },
    {
      name: 'favorite_set',
      scope: 'organize',
      risk: 'R1',
      approval: false,
      summary: '批量收藏或取消收藏',
      handler: async (args) => {
        const record = asRecord(args)
        const ids = readIds(record.assetIds)
        if (record.action === 'add') return services.favorite.add({ assetIds: ids })
        if (record.action === 'remove') return services.favorite.remove({ assetIds: ids })
        throw makeError('E_INVALID_ARG', 'action')
      }
    },
    {
      name: 'library_rename',
      scope: 'organize',
      risk: 'R1',
      approval: false,
      summary: '重命名本地素材；重名按既有规则加序号，不覆盖',
      handler: (args) => {
        const record = asRecord(args)
        return services.library.rename({ id: record.id, newName: record.newName })
      }
    },
    {
      name: 'quarantine_list',
      scope: 'read',
      risk: 'R0',
      approval: false,
      summary: '隔离区列表与可读原因',
      handler: () => services.quarantine.list()
    },
    {
      name: 'media_job',
      scope: 'read',
      risk: 'R0',
      approval: false,
      summary: '媒体处理任务状态、进度与产出路径',
      handler: () => services.media.list()
    },
    {
      name: 'media_submit',
      scope: 'organize',
      risk: 'R1',
      approval: false,
      summary: '提交图片/音视频处理任务（转换、截图、截取、编辑），一律产出新文件',
      handler: (args) => {
        const record = asRecord(args)
        const ids = readIds(record.ids, 'ids')
        if (typeof record.options !== 'object' || record.options === null) {
          throw makeError('E_INVALID_ARG', 'options')
        }
        const action = (record.options as Record<string, unknown>).action
        // 压缩会覆盖原文件，属于破坏性写：不让 agent 触发，必须由用户在界面上确认
        if (action === 'compress') {
          throw makeError('E_SCOPE_DENIED', 'compress must be done in UI')
        }
        return services.media.start({ ids, options: record.options })
      }
    },
    {
      name: 'media_cancel',
      scope: 'organize',
      risk: 'R1',
      approval: false,
      summary: '取消媒体处理任务剩余项；已在处理的单条会做完',
      handler: (args) => {
        const taskId = asRecord(args).taskId
        if (typeof taskId !== 'string' || !taskId) throw makeError('E_INVALID_ARG', 'taskId')
        return services.media.cancel({ taskId })
      }
    },
    {
      name: 'library_trash',
      scope: 'destructive',
      risk: 'R2',
      approval: true,
      summary: '把本地素材移入系统回收站（可还原），必须人工确认',
      preview: async (args) => {
        const ids = readIds(asRecord(args).ids, 'ids')
        const plan = services.library.plan({ ids })
        return {
          action: '移入系统回收站',
          count: plan.items.length,
          paths: plan.items.map((item) => item.path),
          totalBytes: plan.totalBytes,
          reversible: true
        }
      },
      handler: async (args) => {
        const ids = readIds(asRecord(args).ids, 'ids')
        return services.library.trash({ ids })
      }
    },
    {
      name: 'library_move',
      scope: 'destructive',
      risk: 'R2',
      approval: true,
      summary: '把本地素材移动到指定目录，必须人工确认（目录仍受白名单约束）',
      preview: async (args) => {
        const record = asRecord(args)
        const ids = readIds(record.ids, 'ids')
        if (typeof record.targetDir !== 'string' || !record.targetDir) {
          throw makeError('E_INVALID_ARG', 'targetDir')
        }
        const plan = services.library.plan({ ids })
        const dir = record.targetDir.replace(/[\\/]+$/, '')
        return {
          action: `移动到 ${dir}`,
          count: plan.items.length,
          // 预览里连「从哪到哪」都写出来，避免用户只看到「移动 3 个文件」
          paths: plan.items.map((item) => {
            const name = item.path.split(/[\\/]/).pop() ?? ''
            return `${item.path} → ${dir}\\${name}`
          }),
          totalBytes: plan.totalBytes,
          reversible: true
        }
      },
      handler: async (args) => {
        const record = asRecord(args)
        const ids = readIds(record.ids, 'ids')
        return services.library.move({ ids, targetDir: record.targetDir })
      }
    },
    {
      name: 'quarantine_restore',
      scope: 'destructive',
      risk: 'R2',
      approval: true,
      summary: '把隔离区文件恢复到原路径，必须人工确认；原位置被占用时不覆盖',
      preview: (args) => {
        const id = asRecord(args).id
        if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
          throw makeError('E_INVALID_ARG', 'id')
        }
        const plan = services.quarantine.plan({ ids: [id] })
        return {
          action: '从隔离区恢复到原路径',
          count: plan.items.length,
          paths: plan.items.map((item) => item.path),
          totalBytes: null,
          reversible: true
        }
      },
      handler: (args) => services.quarantine.restore(args)
    }
  ]

  const map = new Map(tools.map((tool) => [tool.name, tool]))

  // kithoard_info 需要返回完整工具清单，而清单又来自这张表：
  // 用闭包在调用时求值，避免「表还在构建时就引用自己」的循环初始化。
  map.set('kithoard_info', {
    name: 'kithoard_info',
    scope: 'read',
    risk: 'R0',
    approval: false,
    summary: '接口版本、应用版本、限额与可用工具清单',
    handler: () => ({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      appVersion: deps.appVersion,
      pipeName: AGENT_PIPE_NAME,
      limits: AGENT_LIMITS satisfies AgentLimits,
      tools: toToolInfo(map)
    })
  })

  return map
}

/** 由工具表生成对外清单：一处定义，文档与 kithoard_info 不各写一份 */
export function toToolInfo(tools: Map<string, AgentTool>): AgentToolInfo[] {
  return [...tools.values()].map((tool) => ({
    name: tool.name,
    scope: tool.scope,
    risk: tool.risk,
    approval: tool.approval,
    summary: tool.summary
  }))
}
