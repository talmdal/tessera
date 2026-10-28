import { KeyboardEvent, MouseEvent as ReactMouseEvent, useEffect, useRef } from 'react'
import type { Border } from '@tessera/types'
import { DEFAULT_BAR_SIZE, MIN_BAR_SIZE, maxBarSize } from '../../../shared/layout/types'

const STEP = 10

/** Which way a bar's size grows, as a sign on the pointer's movement, and which arrow key grows it. */
const GROWS = {
  left: { sign: 1, axis: 'x', key: 'ArrowRight' },
  right: { sign: -1, axis: 'x', key: 'ArrowLeft' },
  top: { sign: 1, axis: 'y', key: 'ArrowDown' },
  bottom: { sign: -1, axis: 'y', key: 'ArrowUp' }
} as const

const SHRINKS: Record<string, string> = { ArrowRight: 'ArrowLeft', ArrowLeft: 'ArrowRight', ArrowDown: 'ArrowUp', ArrowUp: 'ArrowDown' }

const clamp = (side: Border, size: number) =>
  Math.min(maxBarSize(side, { width: window.innerWidth, height: window.innerHeight }), Math.max(MIN_BAR_SIZE, Math.round(size)))

/**
 * The draggable edge of a bar. Dragging resizes the bar locally (`onDrag`) and
 * reports the final size once, on release (`onCommit`), so the main process is
 * not flooded. The arrow keys move it by 10 px and report every step; a
 * double-click restores the default size.
 */
export function Splitter({ side, size, onDrag, onCommit }: {
  side: Border
  size: number
  onDrag(size: number): void
  onCommit(size: number): void
}) {
  const stop = useRef<() => void>()
  useEffect(() => () => stop.current?.(), [])       // a drag in progress must not outlive the bar

  const vertical = side === 'left' || side === 'right'
  const grows = GROWS[side]

  const startDrag = (event: ReactMouseEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    const from = grows.axis === 'x' ? event.clientX : event.clientY
    let latest = size
    let moved = false

    const move = (e: MouseEvent) => {
      const at = grows.axis === 'x' ? e.clientX : e.clientY
      latest = clamp(side, size + grows.sign * (at - from))
      moved = true
      onDrag(latest)
    }
    const end = () => {
      stop.current?.()
      if (moved) onCommit(latest)
    }

    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', end)
    stop.current = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', end)
      stop.current = undefined
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const grow = event.key === grows.key
    if (!grow && SHRINKS[event.key] !== grows.key) return
    event.preventDefault()
    onCommit(clamp(side, size + (grow ? STEP : -STEP)))
  }

  const edge = { left: { right: 0 }, right: { left: 0 }, top: { bottom: 0 }, bottom: { top: 0 } }[side]
  return (
    <div role="separator" aria-label={`Resize ${side} bar`} aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-valuenow={size} aria-valuemin={MIN_BAR_SIZE} aria-valuemax={maxBarSize(side, { width: window.innerWidth, height: window.innerHeight })}
      tabIndex={0} onMouseDown={startDrag} onKeyDown={onKeyDown} onDoubleClick={() => onCommit(DEFAULT_BAR_SIZE[side])}
      style={{
        position: 'absolute', zIndex: 1, ...edge,
        ...(vertical ? { top: 0, bottom: 0, width: 6, cursor: 'col-resize' } : { left: 0, right: 0, height: 6, cursor: 'row-resize' })
      }} />
  )
}
