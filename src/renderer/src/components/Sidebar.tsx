interface NavItem {
  id: string
  label: string
  available: boolean
  note: string
}

const NAV_ITEMS: NavItem[] = [
  { id: 'search', label: '首页搜索', available: true, note: '当前可用' },
  { id: 'downloads', label: '下载管理', available: false, note: 'V0.2 提供' },
  { id: 'library', label: '本地素材', available: false, note: 'V0.2 提供' },
  { id: 'favorites', label: '收藏夹', available: false, note: 'V0.3 提供' },
  { id: 'sites', label: '网站导航', available: false, note: 'V0.6 提供' },
  { id: 'settings', label: '设置', available: false, note: '从首页引导填写 Key' }
]

export default function Sidebar() {
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
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.available ? 'rail__item rail__item--active' : 'rail__item'}
            disabled={!item.available}
            aria-current={item.available ? 'page' : undefined}
            title={item.note}
          >
            <span>{item.label}</span>
            {item.available ? null : <span className="rail__note">{item.note}</span>}
          </button>
        ))}
      </nav>

      <div className="rail__foot">
        <p>本地素材中转站</p>
        <p className="rail__version">V0.1</p>
      </div>
    </aside>
  )
}
