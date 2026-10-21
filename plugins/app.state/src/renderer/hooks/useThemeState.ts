import { useEffect, useState } from 'react'
import { appState } from '../api'

export function useThemeState() {
  const [theme, setTheme] = useState('light')

  useEffect(() => {
    ;(async () => {
      const saved = await appState.get('theme', 'light')
      setTheme(saved)
      document.body.dataset.theme = saved
    })()
  }, [])

  const toggleTheme = async () => {
    const next = theme === 'light' ? 'dark' : 'light'
    setTheme(next)
    document.body.dataset.theme = next
    await appState.set('theme', next)
  }

  return { theme, toggleTheme }
}
