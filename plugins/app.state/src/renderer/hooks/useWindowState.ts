import { useEffect } from 'react'
import { appState } from '../api'

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

    const handler = () => {
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

    window.addEventListener('resize', handler)
    window.addEventListener('move', handler)

    return () => {
      window.removeEventListener('resize', handler)
      window.removeEventListener('move', handler)
    }
  }, [])
}
