interface NavItem {
  id: string
  label: string
  available: boolean
  note: string
}

const NAV_ITEMS: NavItem[] = [
  { id: 'search', label: '首页搜索', available: true, note: '' },
  { id: 'downloads', label: '下载管理', available: true, note: '' },
  { id: 'library', label: '本地素材', available: false, note: '下一批提供' },
  { id: 'favorites', label: '收藏夹', available: false, note: 'V0.3 提供' },
  { id: 'sites', label: '网站导航', available: false, note: 'V0.6 提供' },
  { id: 'settings', label: '设置', available: false, note: '从首页引导填写 Key' }
]

type NavKey = 'search' | 'downloads'

interface Props {
  current: NavKey
  onNavigate: (target: NavKey) => void
}

export default function Sidebar({ current, onNavigate }: Props) {
  return (
    <aside className="rail">
      <div className="brand">
        <span className="brand__mark" aria-hidden="true">
          K
        </span>
        <span className="brand__text">
          <span className="brand__name">Kithoard</span>
          <span className="brand__sub">栖材坞</span>
        </span>
      </div>

      <nav className="rail__nav" aria-label="主导航">
        {NAV_ITEMS.map((item) => {
          const active = item.available && item.id === current
          return (
            <button
              key={item.id}
              type="button"
              className={active ? 'rail__item rail__item--active' : 'rail__item'}
              disabled={!item.available}
              aria-current={active ? 'page' : undefined}
              title={item.note || item.label}
              onClick={() => {
                // 只有已开放的两个页面可跳转；其余项的 available=false 已在按钮上禁用
                if (item.available && (item.id === 'search' || item.id === 'downloads')) {
                  onNavigate(item.id)
                }
              }}
            >
              <span>{item.label}</span>
              {item.note && !item.available ? <span className="rail__note">{item.note}</span> : null}
            </button>
          )
        })}
      </nav>

      <div className="rail__foot">
        <p>本地素材中转站</p>
        <p className="rail__version">V0.2</p>
      </div>
    </aside>
  )
}
