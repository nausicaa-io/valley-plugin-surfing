import type { PlaybackSource, PluginPlaybackHandle, ValleyPluginApi } from '@valley/plugin-sdk'
import { createUiText } from './localization'

export function createGuestLifetime(api: ValleyPluginApi, options: {
  instanceId: string
  guestId: string
  profileId: string
  current(): boolean
  page(): { url: string; title: string } | undefined
  audible(): boolean
}) {
  const text = createUiText(api)
  const work = new Set<Promise<unknown>>()
  let closed = false
  let disposal: Promise<void> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let playback: PluginPlaybackHandle | undefined
  let mediaActive = false
  let volume = 1
  const active = (): boolean => !closed && options.current()
  const run = <T,>(operation: () => Promise<T>): Promise<T> => {
    if (!active()) return Promise.reject(new Error(text('surfing.error.liveTab', { value: options.instanceId })))
    const accepted = (async () => operation())()
    work.add(accepted)
    void accepted.then(() => work.delete(accepted), () => work.delete(accepted))
    return accepted
  }
  const execute = (script: string): void => {
    if (!active()) return
    void run(() => api.drivers.browser.execute(options.guestId, script, false)).catch(() => {})
  }
  const source = (isPlaying: boolean): PlaybackSource => {
    const page = options.page()
    let site = page?.url ?? ''
    try { site = new URL(site).hostname || site } catch {}
    return {
      id: `web:${options.instanceId}`, title: page?.title || site || 'Web audio', artist: site || undefined,
      isPlaying, canSkip: false, volume,
      setVolume(value) {
        if (!active()) return
        volume = Math.max(0, Math.min(1, value))
        execute(`document.querySelectorAll('video,audio').forEach(e=>{e.volume=${volume};e.muted=${volume === 0}})`)
        try { if (mediaActive) playback?.update(source(true)) } catch {}
      },
      toggle: () => execute(`(()=>{const m=[...document.querySelectorAll('video,audio')];const p=m.some(e=>!e.paused);m.forEach(e=>{p?e.pause():e.play()})})()`),
      pause: () => { cancelRetry(); execute(`document.querySelectorAll('video,audio').forEach(e=>e.pause())`) }
    }
  }
  const cancelRetry = (): void => { if (retry !== undefined) clearTimeout(retry); retry = undefined }
  const play = (attempt = 0): void => {
    cancelRetry()
    if (!active()) return
    let audible = false
    try { audible = options.audible() } catch { audible = true }
    if (!audible) {
      if (attempt < 3) retry = setTimeout(() => { retry = undefined; play(attempt + 1) }, 500)
      return
    }
    if (volume !== 1) execute(`document.querySelectorAll('video,audio').forEach(e=>{e.volume=${volume};e.muted=${volume === 0}})`)
    mediaActive = true
    try {
      const next = source(true)
      playback ??= api.playback.register(next)
      playback.claim(next)
    } catch {}
  }
  return {
    profileId: options.profileId,
    active,
    run,
    play,
    pause(): void {
      cancelRetry()
      try { if (active() && mediaActive) playback?.update(source(false)) } catch {}
    },
    dispose(cleanup?: () => void | Promise<void>): Promise<void> {
      if (disposal) return disposal
      closed = true
      cancelRetry()
      let playbackFailure: unknown
      try { playback?.dispose() } catch (error) { playbackFailure = error }
      playback = undefined
      const stopped = Promise.resolve().then(() => cleanup?.())
      return disposal = (async () => {
        const cleanupResult = await Promise.allSettled([stopped])
        while (work.size) await Promise.allSettled([...work])
        const result = await api.drivers.browser.close(options.guestId)
        if (!result.ok) throw new Error(result.error || text('surfing.error.liveTab', { value: options.instanceId }))
        if (cleanupResult[0].status === 'rejected') throw cleanupResult[0].reason
        if (playbackFailure) throw playbackFailure
      })()
    }
  }
}

export type GuestLifetime = ReturnType<typeof createGuestLifetime>
