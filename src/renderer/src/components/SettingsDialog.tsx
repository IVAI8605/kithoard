import { useEffect, useState } from 'react'
import { useAppStore } from '../store'

interface Props {
  onClose: () => void
}

export default function SettingsDialog({ onClose }: Props) {
  const sources = useAppStore((state) => state.sources)
  const keyStorage = useAppStore((state) => state.keyStorage)
  const saveApiKey = useAppStore((state) => state.saveApiKey)
  const toggleSource = useAppStore((state) => state.toggleSource)

  const [keyInput, setKeyInput] = useState('')
  const [feedback, setFeedback] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const pixabay = sources.find((source) => source.id === 'pixabay')
  const hasKey = Boolean(pixabay?.hasApiKey)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submitKey = async (value: string): Promise<void> => {
    setBusy(true)
    const error = await saveApiKey('pixabay', value)
    setBusy(false)
    if (error) {
      setFeedback(error.message)
      return
    }
    setKeyInput('')
    setFeedback(value ? 'Key 已保存' : 'Key 已清除')
  }

  return (
    <div className="overlay" onClick={onClose} role="presentation">
      <section
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dialog__head">
          <h2 id="settings-title">设置</h2>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            关闭
          </button>
        </header>

        <section className="dialog__section">
          <h3>Pixabay API Key</h3>
          <p className="dialog__hint">
            状态：{hasKey ? '已配置' : '未配置'}。Key 只保存在本机。
            <a href="https://pixabay.com/api/docs/" target="_blank" rel="noreferrer">
              获取免费 Key
            </a>
          </p>
          <form
            className="dialog__form"
            onSubmit={(event) => {
              event.preventDefault()
              void submitKey(keyInput)
            }}
          >
            <input
              type="password"
              value={keyInput}
              onChange={(event) => setKeyInput(event.target.value)}
              placeholder={hasKey ? '填入新 Key 可替换' : '粘贴 Pixabay API Key'}
              aria-label="Pixabay API Key"
              autoFocus
            />
            <button type="submit" className="btn btn--primary" disabled={busy || !keyInput.trim()}>
              保存
            </button>
          </form>
          {hasKey ? (
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => void submitKey('')}
            >
              清除已保存的 Key
            </button>
          ) : null}
          {keyStorage === 'plaintext' ? (
            <p className="dialog__warn">
              当前系统不支持安全加密，Key 会以明文保存在本机数据库，请注意电脑本身的安全。
            </p>
          ) : null}
        </section>

        <section className="dialog__section">
          <h3>素材源</h3>
          <label className="switch-row">
            <input
              type="checkbox"
              checked={pixabay?.enabled ?? false}
              disabled={busy}
              onChange={(event) => {
                setBusy(true)
                void toggleSource('pixabay', event.target.checked).then((error) => {
                  setBusy(false)
                  if (error) setFeedback(error.message)
                })
              }}
            />
            <span>启用 Pixabay</span>
            <span className="muted">图片与视频</span>
          </label>
        </section>

        {feedback ? <p className="dialog__feedback">{feedback}</p> : null}
      </section>
    </div>
  )
}
