import { useEffect, useRef, useState } from 'react'
import type { MediaProcessOptions, MediaTaskItem } from '@shared/types'

export interface MediaTaskState {
  running: boolean
  finished: boolean
  progress: { done: number; total: number; failed: number }
  failures: MediaTaskItem[]
  error: string | null
}

/**
 * 媒体处理任务的共用状态：订阅主进程进度、启动、取消。
 * 图片与音视频面板都走这一份，避免三套几乎相同的订阅逻辑。
 */
export function useMediaTask(onDone: () => void) {
  const [running, setRunning] = useState(false)
  const [finished, setFinished] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0, failed: 0 })
  const [failures, setFailures] = useState<MediaTaskItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const taskIdRef = useRef<string | null>(null)

  // 父组件的 onDone 每次渲染都是新函数；用 ref 固定引用，避免订阅被反复重建
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => {
    const off = window.api.media.onProgress((event) => {
      setProgress({ done: event.done, total: event.total, failed: event.failed })
      if (event.item.state === 'failed') {
        setFailures((prev) => [...prev, event.item])
      }
      if (event.done >= event.total) {
        setRunning(false)
        setFinished(true)
        onDoneRef.current()
      }
    })
    return off
  }, [])

  const start = async (fileIds: number[], options: MediaProcessOptions): Promise<void> => {
    setError(null)
    setRunning(true)
    setFinished(false)
    setFailures([])
    setProgress({ done: 0, total: fileIds.length, failed: 0 })
    const result = await window.api.media.start(fileIds, options)
    if (!result.ok) {
      setRunning(false)
      setError(result.error.message)
      return
    }
    taskIdRef.current = result.data.taskId
  }

  const cancel = async (): Promise<void> => {
    if (!taskIdRef.current) return
    await window.api.media.cancel(taskIdRef.current)
  }

  return {
    running,
    finished,
    progress,
    failures,
    error,
    start,
    cancel,
    setError
  }
}
