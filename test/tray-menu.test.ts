import { describe, expect, it, vi } from 'vitest'
import { buildTrayMenu } from '../src/main/tray-menu'

function handlers() {
  return {
    onOpenHome: vi.fn(),
    onOpenSettings: vi.fn(),
    onQuit: vi.fn()
  }
}

describe('托盘菜单', () => {
  it('按「打开主页面 / 设置 / 退出」排列，中间有分隔线', () => {
    const items = buildTrayMenu(handlers())
    expect(items.map((item) => item.label ?? item.type)).toEqual([
      '打开主页面',
      '设置',
      'separator',
      '退出'
    ])
  })

  it('每一项都接上了对应的动作', () => {
    const h = handlers()
    const items = buildTrayMenu(h)

    items[0].click?.()
    expect(h.onOpenHome).toHaveBeenCalledTimes(1)

    items[1].click?.()
    expect(h.onOpenSettings).toHaveBeenCalledTimes(1)

    items[3].click?.()
    expect(h.onQuit).toHaveBeenCalledTimes(1)
  })

  it('分隔线不带动作，避免误点触发退出', () => {
    const h = handlers()
    const items = buildTrayMenu(h)
    expect(items[2].click).toBeUndefined()
    expect(items[2].label).toBeUndefined()
  })
})
