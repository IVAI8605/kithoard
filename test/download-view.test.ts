import { describe, expect, it } from 'vitest'
import {
  actionsOf,
  errorText,
  fileNameOf,
  formatBytes,
  formatProgress,
  isFinished,
  moveTask,
  progressPercent,
  stateLabel,
  stateTone
} from '../src/renderer/src/downloadView'
import type { DownloadState } from '../src/shared/types'

const ALL_STATES: DownloadState[] = [
  'queued',
  'downloading',
  'paused',
  'verifying',
  'completed',
  'failed',
  'canceled',
  'quarantined'
]

describe('下载页展示映射', () => {
  it('8 个状态都有中文文案，没有漏项', () => {
    for (const state of ALL_STATES) {
      expect(stateLabel(state).length).toBeGreaterThan(0)
    }
    expect(stateLabel('downloading')).toBe('下载中')
    expect(stateLabel('quarantined')).toBe('已隔离')
  })

  it('状态色调用前景分类，不把失败和隔离混成同一类', () => {
    expect(stateTone('downloading')).toBe('active')
    expect(stateTone('paused')).toBe('paused')
    expect(stateTone('completed')).toBe('done')
    expect(stateTone('failed')).toBe('failed')
    expect(stateTone('quarantined')).toBe('risk')
  })

  it('按钮只在对当前状态合法时出现', () => {
    expect(actionsOf('downloading')).toEqual({
      pause: true,
      resume: false,
      retry: false,
      cancel: true
    })
    expect(actionsOf('paused')).toMatchObject({ resume: true, cancel: true })
    expect(actionsOf('failed')).toMatchObject({ retry: true, cancel: true })
    // 已完成/已取消/已隔离都不该再给暂停或重试
    expect(actionsOf('completed')).toEqual({
      pause: false,
      resume: false,
      retry: false,
      cancel: false
    })
    expect(actionsOf('quarantined').cancel).toBe(false)
  })

  it('只有 completed / canceled 算结束态，failed 仍要用户处理', () => {
    expect(isFinished('completed')).toBe(true)
    expect(isFinished('canceled')).toBe(true)
    expect(isFinished('failed')).toBe(false)
    expect(isFinished('quarantined')).toBe(false)
  })
})

describe('下载进度计算', () => {
  it('总大小未知时不画百分比，避免出现假的 0%', () => {
    expect(progressPercent(1024, null)).toBeNull()
  })

  it('总大小为 0 或非法时同样返回 null', () => {
    expect(progressPercent(0, 0)).toBeNull()
    expect(progressPercent(0, -1)).toBeNull()
  })

  it('正常比例四舍五入，超出总大小按 100% 封顶', () => {
    expect(progressPercent(0, 1000)).toBe(0)
    expect(progressPercent(505, 1000)).toBe(51)
    expect(progressPercent(2000, 1000)).toBe(100)
  })

  it('字节格式化覆盖 B / KB / MB / GB', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB')
    expect(formatBytes(-1)).toBe('—')
  })

  it('总大小未知时只显示已下载字节', () => {
    expect(formatProgress(1536, null)).toBe('已下载 1.5 KB')
    expect(formatProgress(512, 1024)).toBe('512 B / 1.0 KB')
  })
})

describe('拖拽排序', () => {
  it('把后面的任务拖到前面', () => {
    expect(moveTask(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
  })

  it('把前面的任务拖到后面', () => {
    expect(moveTask(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a'])
  })

  it('原地放下或 ID 不存在时保持原顺序', () => {
    const ids = ['a', 'b', 'c']
    expect(moveTask(ids, 'b', 'b')).toEqual(ids)
    expect(moveTask(ids, 'x', 'a')).toEqual(ids)
    expect(moveTask(ids, 'a', 'x')).toEqual(ids)
  })

  it('不修改传入数组', () => {
    const ids = ['a', 'b', 'c']
    moveTask(ids, 'a', 'c')
    expect(ids).toEqual(['a', 'b', 'c'])
  })
})

describe('文件名与错误文案', () => {
  it('Windows 路径也能取出文件名', () => {
    expect(fileNameOf('C:\\Users\\me\\Pictures\\Kithoard\\mountain.jpg')).toBe('mountain.jpg')
    expect(fileNameOf('/home/me/pictures/sea.png')).toBe('sea.png')
    expect(fileNameOf('bare-name.png')).toBe('bare-name.png')
  })

  it('已知错误码转中文，未知码原样显示', () => {
    expect(errorText('E_TEMP_MISSING')).toBe('临时文件已丢失，请重新下载')
    expect(errorText('E_SOMETHING_NEW')).toBe('E_SOMETHING_NEW')
    expect(errorText(null)).toBeNull()
  })
})
