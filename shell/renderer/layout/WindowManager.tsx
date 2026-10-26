// shell/renderer/layout/WindowManager.tsx
//
// The frame of the window: the main content area with a collapsible bar on
// each side. What each region contains is decided by the main process
// (LayoutService) and mirrored here; see docs/window-manager-design.md.
import type { LayoutRevealedEvent } from '@tessera/types'
import { KeyboardEvent, ReactNode, useEffect, useRef } from 'react'
import { LAYOUT_REVEALED } from '../../../shared/layout/types'
import { useLayout, useShellBridge } from '../state/ShellState'
import { BarViews } from './Bar'
import { Bar } from './Bar'
import './windowManager.css'

export function WindowManager({ fallback = null }: { fallback?: ReactNode }) {
  const layout = useLayout()
  const bridge = useShellBridge()
  const root = useRef<HTMLDivElement>(null)
  const windowId = useRef(layout.windowId)
  windowId.current = layout.windowId

  // After a reveal the bar is already expanded (layout.changed precedes the
  // revealed event); scroll the view's section into sight and focus it.
  useEffect(() => bridge.on<LayoutRevealedEvent>(LAYOUT_REVEALED, event => {
    if (event.windowId !== windowId.current) return
    requestAnimationFrame(() => {
      const section = root.current?.querySelector<HTMLElement>(`[data-view-id="${CSS.escape(event.viewId)}"]`)
      section?.scrollIntoView?.({ block: 'nearest' })
      section?.focus()
    })
  }), [bridge])

  // F6 / Shift+F6 cycles focus through the visible regions in reading order.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'F6') return
    event.preventDefault()
    const regions = [...(root.current?.querySelectorAll<HTMLElement>('[data-wm-region]') ?? [])]
    if (regions.length === 0) return
    const current = regions.findIndex(region => region.contains(document.activeElement))
    const step = event.shiftKey ? -1 : 1
    regions[(current + step + regions.length) % regions.length].focus()
  }

  return (
    <div className="wm" ref={root} onKeyDown={onKeyDown}>
      <Bar side="top" />
      <Bar side="left" />
      <main className="wm-main" aria-label="Main content" data-wm-region="main" tabIndex={-1}>
        <MainArea fallback={fallback} />
      </main>
      <Bar side="right" />
      <Bar side="bottom" />
    </div>
  )
}

/**
 * The centre: one active view, chosen by commands (shell.layout.reveal). No
 * tab strip; the welcome fallback shows when nothing targets the main slot.
 */
function MainArea({ fallback }: { fallback: ReactNode }) {
  const { main } = useLayout()
  if (main.views.length === 0) return <>{fallback}</>
  return <BarViews bar={main} />
}
