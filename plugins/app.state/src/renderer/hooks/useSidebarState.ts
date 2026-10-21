import { useEffect, useState } from 'react'
import { appState } from '../api'

export function useSidebarState() {
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    ;(async () => {
      const saved = await appState.get('sidebar', { collapsed: false })
      setCollapsed(saved.collapsed)
    })()
  }, [])

  const toggleSidebar = async () => {
    const next = !collapsed
    setCollapsed(next)
    await appState.set('sidebar', { collapsed: next })
  }

  return { collapsed, toggleSidebar }
}
