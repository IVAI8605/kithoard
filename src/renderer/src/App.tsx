import { useEffect, useState } from 'react'
import Sidebar from './components/Sidebar'
import SettingsDialog from './components/SettingsDialog'
import DetailView from './pages/DetailView'
import SearchPage from './pages/SearchPage'
import { useAppStore } from './store'

type View = { name: 'search' } | { name: 'detail'; assetId: number }

export default function App() {
  const loadSources = useAppStore((state) => state.loadSources)
  const settingsOpen = useAppStore((state) => state.settingsOpen)
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen)
  const [view, setView] = useState<View>({ name: 'search' })

  useEffect(() => {
    void loadSources()
  }, [loadSources])

  return (
    <div className="app">
      <Sidebar />
      <main className="content">
        {view.name === 'search' ? (
          <SearchPage onOpenDetail={(assetId) => setView({ name: 'detail', assetId })} />
        ) : (
          <DetailView assetId={view.assetId} onBack={() => setView({ name: 'search' })} />
        )}
      </main>
      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  )
}
