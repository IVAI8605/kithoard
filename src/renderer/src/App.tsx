import { useEffect, useState } from 'react'
import Sidebar from './components/Sidebar'
import SettingsDialog from './components/SettingsDialog'
import StartupRecoveryDialog from './components/StartupRecoveryDialog'
import DetailView from './pages/DetailView'
import DownloadsPage from './pages/DownloadsPage'
import LibraryPage from './pages/LibraryPage'
import SearchPage from './pages/SearchPage'
import { useAppStore } from './store'

type NavKey = 'search' | 'downloads' | 'library'
/** 详情页记住从哪来的，返回时不会把用户莫名送回首页 */
type View = { name: NavKey } | { name: 'detail'; assetId: number; from: NavKey }

export default function App() {
  const loadSources = useAppStore((state) => state.loadSources)
  const settingsOpen = useAppStore((state) => state.settingsOpen)
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen)
  const recovery = useAppStore((state) => state.recovery)
  const setRecovery = useAppStore((state) => state.setRecovery)
  const loadDownloads = useAppStore((state) => state.loadDownloads)
  const startQueue = useAppStore((state) => state.startQueue)
  const [view, setView] = useState<View>({ name: 'search' })
  const [recoveryOpen, setRecoveryOpen] = useState(false)

  useEffect(() => {
    void loadSources()
  }, [loadSources])

  // 启动恢复由主进程完成，这里只取报告；有排队任务才询问，避免每次开软件都弹窗
  useEffect(() => {
    let cancelled = false
    void window.api.download.recover().then((result) => {
      if (cancelled || !result.ok) return
      setRecovery(result.data)
      setRecoveryOpen(result.data.pendingQueued > 0)
      void loadDownloads()
    })
    return () => {
      cancelled = true
    }
  }, [setRecovery, loadDownloads])

  // 事件全局订阅一次：用户切到别的页面再回来，进度仍在更新，不必按页重复挂监听
  useEffect(() => {
    const offProgress = window.api.download.onProgress((event) =>
      useAppStore.getState().applyProgress(event)
    )
    const offState = window.api.download.onState((event) =>
      useAppStore.getState().applyState(event)
    )
    return () => {
      offProgress()
      offState()
    }
  }, [])

  const currentNav: NavKey = view.name === 'detail' ? view.from : view.name

  return (
    <div className="app">
      <Sidebar current={currentNav} onNavigate={(name) => setView({ name })} />
      <main className="content">
        {view.name === 'search' ? (
          <SearchPage
            onOpenDetail={(assetId) => setView({ name: 'detail', assetId, from: 'search' })}
          />
        ) : null}
        {view.name === 'downloads' ? (
          <DownloadsPage
            onOpenDetail={(assetId) => setView({ name: 'detail', assetId, from: 'downloads' })}
          />
        ) : null}
        {view.name === 'library' ? <LibraryPage /> : null}
        {view.name === 'detail' ? (
          <DetailView assetId={view.assetId} onBack={() => setView({ name: view.from })} />
        ) : null}
      </main>
      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
      {recoveryOpen && recovery ? (
        <StartupRecoveryDialog
          report={recovery}
          onStart={() => {
            void startQueue()
            setRecoveryOpen(false)
          }}
          onLater={() => setRecoveryOpen(false)}
          onOpenDownloads={() => {
            setView({ name: 'downloads' })
            setRecoveryOpen(false)
          }}
        />
      ) : null}
    </div>
  )
}
