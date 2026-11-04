// shell/renderer/WindowReady.tsx
import { useEffect } from 'react'
import type { TesseraBridge } from '@tessera/types'
import { WINDOW_READY } from '../../shared/shellEvents'
import { useLayout } from './state/ShellState'

/**
 * Tells the main process, once, that this window's first frame is ready to be
 * seen, so it can show the window it created hidden. Ready means its layout has
 * arrived (so the frame is the right shape) and a frame with it has been
 * painted. The theme is already applied by then: nothing renders without it.
 */
export function WindowReady({ bridge }: { bridge: Pick<TesseraBridge, 'invoke'> }) {
  const loaded = useLayout().windowId !== -1

  useEffect(() => {
    if (!loaded) return

    // The effect runs after the DOM is updated but before it is painted; wait for the paint.
    let cancelled = false
    const signal = () => {
      if (!cancelled) bridge.invoke(WINDOW_READY).catch(err => console.error('[window] Could not report ready', err))
    }
    const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => requestAnimationFrame(signal)) : undefined
    const timer = frame === undefined ? setTimeout(signal, 0) : undefined

    return () => {
      cancelled = true
      if (frame !== undefined) cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [loaded, bridge])

  return null
}
