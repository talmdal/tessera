import { useEffect } from 'react'
import { appState } from '../api'

/** Resize and move fire continuously; the bounds are saved this long after the last one. */
const SAVE_DELAY_MS = 250

export function useWindowState() {
  useEffect(() => {
    ;(async () => {
      const state = await appState.get('window', {
        x: window.screenX,
        y: window.screenY,
        width: window.innerWidth,
        height: window.innerHeight,
        maximized: false
      })

      if (state.maximized) {
        window.api.invoke('window:maximize')
      } else {
        window.api.invoke('window:setBounds', state)
      }
    })()

    let timer: ReturnType<typeof setTimeout> | undefined
    const save = () => {
      timer = undefined
      appState.set('window', {
        x: window.screenX,
        y: window.screenY,
        width: window.innerWidth,
        height: window.innerHeight,
        maximized:
          window.outerWidth === screen.availWidth &&
          window.outerHeight === screen.availHeight
      })
    }
    const handler = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(save, SAVE_DELAY_MS)
    }

    window.addEventListener('resize', handler)
    window.addEventListener('move', handler)

    return () => {
      window.removeEventListener('resize', handler)
      window.removeEventListener('move', handler)
      if (timer) {
        clearTimeout(timer)
        save()
      }
    }
  }, [])
}
