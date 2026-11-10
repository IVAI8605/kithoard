/**
 * 托盘菜单项定义与 Electron 解耦：点击行为由调用方注入，
 * 这样「点哪一项调哪个动作」可以被单测直接断言，不必拉起真托盘。
 */
export interface TrayMenuHandlers {
  onOpenHome: () => void
  onOpenSettings: () => void
  onQuit: () => void
}

export interface TrayMenuItem {
  label?: string
  type?: 'separator'
  click?: () => void
}

export function buildTrayMenu(handlers: TrayMenuHandlers): TrayMenuItem[] {
  return [
    { label: '打开主页面', click: handlers.onOpenHome },
    { label: '设置', click: handlers.onOpenSettings },
    { type: 'separator' },
    { label: '退出', click: handlers.onQuit }
  ]
}
