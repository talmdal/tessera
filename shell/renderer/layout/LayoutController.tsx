import { ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { Border, BorderState } from '@tessera/types'
import { BAR_SIDES, RAIL_SIZE, SLOT_FOR_SIDE, barHasContent } from '../../../shared/layout/types'
import { useLayout, useLayoutActions, useRevealed } from '../state/ShellState'
import { Bar } from './Bar'
import { MainArea } from './MainArea'

/** The regions F6 cycles through, in reading order. */
const REGIONS = ['top', 'left', 'main', 'right', 'bottom'] as const

/** The track a bar takes: nothing when hidden, a rail when collapsed, its size when expanded and holding views. */
function trackOf(bar: BorderState, size: number) {
  if (!barHasContent(bar)) return '0px'
  if (bar.collapsed) return `${RAIL_SIZE}px`
  if (bar.views.length === 0) return 'auto'      // a tool or status strip is as big as its content
  return `min(${size}px, 50%)`                   // never more than half the window
}

/**
 * The shell's fixed frame: the main area with a bar on each side. The layout
 * controller in the main process decides what is in it and in what state; this
 * mirrors that and sends the user's gestures back.
 */
export function LayoutController({ welcome }: { welcome: ReactNode }) {
  const { bars } = useLayout()
  const { setSlot } = useLayoutActions()
  const root = useRef<HTMLDivElement>(null)

  // While a splitter is being dragged its bar follows the pointer here, with no request to the main process.
  // The size stays until the controller has answered the final one, so the bar does not jump back meanwhile.
  const [dragged, setDragged] = useState<Partial<Record<Border, number>>>({})
  const onDrag = useCallback((side: Border, size: number | undefined) => {
    setDragged(current => {
      const { [side]: _dropped, ...rest } = current
      return size === undefined ? rest : { ...rest, [side]: size }
    })
  }, [])
  const onResize = useCallback((side: Border, size: number) => {
    onDrag(side, size)
    setSlot({ slot: SLOT_FOR_SIDE[side], size }).then(() => onDrag(side, undefined))
  }, [onDrag, setSlot])
  const sizeOf = (side: Border) => dragged[side] ?? bars[side].size
  const track = (side: Border) => trackOf(bars[side], sizeOf(side))

  // A revealed view takes focus, once it has been drawn.
  const [revealed, setRevealed] = useState<string>()
  useRevealed(({ viewId }) => setRevealed(viewId))
  useEffect(() => {
    if (revealed === undefined) return
    const section = [...document.querySelectorAll<HTMLElement>('[data-view-id]')].find(el => el.dataset.viewId === revealed)
    section?.focus()
    section?.scrollIntoView?.({ block: 'nearest' })
    setRevealed(undefined)
  }, [revealed])

  // F6 and Shift+F6 move focus to the next and previous region.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'F6') return
      const regions = REGIONS
        .map(name => root.current?.querySelector<HTMLElement>(`[data-region="${name}"]`))
        .filter((region): region is HTMLElement => !!region)
      if (regions.length === 0) return

      event.preventDefault()
      const direction = event.shiftKey ? -1 : 1
      const current = regions.findIndex(region => region.contains(document.activeElement))
      const next = current === -1 ? (direction > 0 ? 0 : regions.length - 1) : (current + direction + regions.length) % regions.length
      regions[next].focus()
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div ref={root} data-layout style={{
      display: 'grid',
      height: '100vh',
      gridTemplateAreas: '"top top top" "left main right" "bottom bottom bottom"',
      gridTemplateColumns: `${track('left')} minmax(0, 1fr) ${track('right')}`,
      gridTemplateRows: `${track('top')} minmax(0, 1fr) ${track('bottom')}`
    }}>
      {BAR_SIDES.map(side => <Bar key={side} side={side} size={sizeOf(side)} onDrag={onDrag} onResize={onResize} />)}
      <MainArea fallback={welcome} />
    </div>
  )
}
