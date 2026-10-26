// shell/renderer/layout/Bar.tsx
//
// One side of the frame. Hidden (nothing rendered) when the layout lists no
// content for it, a rail of icons when collapsed, otherwise items strip, tab
// strip and the active view, with a splitter on the inner edge when it holds
// views. All decisions about presence come from the main process; gestures go
// back as shell:layout.slot.set requests.
import type { BarSide, BarState, LayoutSlotSetRequest } from '@tessera/types'
import { CSSProperties, Fragment, ReactNode, useRef, useState } from 'react'
import { DEFAULT_BAR_SIZE, LAYOUT_SLOT_SET, barHasContent, slotOfSide } from '../../../shared/layout/types'
import { useBar, useShellBridge } from '../state/ShellState'
import { ViewHost, useViewCatalogue } from '../views/ViewsProvider'
import { Icon } from './Icon'
import { ItemStrip } from './ItemStrip'

const SIDE_LABEL: Record<BarSide, string> = { top: 'Top bar', bottom: 'Bottom bar', left: 'Left bar', right: 'Right bar' }
const COLLAPSE_ICON: Record<BarSide, string> = { top: 'chevron-up', bottom: 'chevron-down', left: 'chevron-left', right: 'chevron-right' }
const EXPAND_ICON: Record<BarSide, string> = { top: 'chevron-down', bottom: 'chevron-up', left: 'chevron-right', right: 'chevron-left' }

export function Bar({ side }: { side: BarSide }) {
  const bar = useBar(side)
  const bridge = useShellBridge()
  /** Size while a splitter drag is in progress; null otherwise. */
  const [previewSize, setPreviewSize] = useState<number | null>(null)

  if (!barHasContent(bar)) return null

  const set = (change: Omit<LayoutSlotSetRequest, 'slot'>) => {
    const request: LayoutSlotSetRequest = { slot: slotOfSide(side), ...change }
    bridge.invoke(LAYOUT_SLOT_SET, request).catch(err =>
      console.error(`[layout] Could not update the ${side} bar`, err))
  }

  const hasViews = bar.views.length > 0
  const collapsed = bar.collapsed
  const horizontal = side === 'top' || side === 'bottom'
  const size = previewSize ?? bar.size
  // A bar with only items is content-sized; with views it uses its size.
  const style = collapsed || !hasViews ? undefined
    : horizontal ? { height: size, maxHeight: '50vh' } : { width: size, maxWidth: '50vw' }

  // The chrome swaps between rail and strips, but the views area keeps its key,
  // so shown views stay mounted across a collapse (their state survives), and a
  // collapsed bar loads nothing: with no active view, BarViews shows none.
  const chrome = (
    <Fragment key="chrome">
      {collapsed
        ? <RailTools side={side} bar={bar} set={set} />
        : <>
            {side !== 'bottom' && bar.items.length > 0 && <ItemStrip itemIds={bar.items} />}
            {hasViews && <TabStrip side={side} bar={bar} set={set} />}
          </>}
    </Fragment>
  )

  const viewsArea = hasViews &&
    <div key="views" className="wm-bar-views" hidden={collapsed}>
      <BarViews bar={{ views: bar.views, activeView: collapsed ? undefined : bar.activeView }} />
    </div>

  // The items strip hugs the window edge: on the bottom bar it goes below the views.
  const bottomStrip = !collapsed && side === 'bottom' && bar.items.length > 0 &&
    <Fragment key="strip"><ItemStrip itemIds={bar.items} /></Fragment>

  const splitter = !collapsed && hasViews &&
    <Fragment key="splitter">
      <Splitter side={side} size={bar.size}
        onPreview={setPreviewSize} onCommit={next => { setPreviewSize(null); set({ size: next }) }} />
    </Fragment>

  return (
    <Region side={side} className={collapsed ? `wm-rail wm-rail-${side}` : `wm-bar wm-bar-${side}`} style={style}>
      {[chrome, viewsArea, bottomStrip, splitter]}
    </Region>
  )
}

/** The landmark element for a side: header (top), footer (bottom), aside (left, right). */
function Region({ side, className, style, children }: {
  side: BarSide, className: string, style?: CSSProperties, children: ReactNode
}) {
  const props = { className, style, 'aria-label': SIDE_LABEL[side], 'data-wm-region': side, tabIndex: -1 as const }
  if (side === 'top') return <header {...props}>{children}</header>
  if (side === 'bottom') return <footer {...props}>{children}</footer>
  return <aside {...props}>{children}</aside>
}

/** A collapsed bar's toolbar: one icon per present view (the active one marked), or a single expand button. */
function RailTools({ side, bar, set }: {
  side: BarSide
  bar: BarState
  set(change: Omit<LayoutSlotSetRequest, 'slot'>): void
}) {
  const { byId } = useViewCatalogue()

  return (
    <div role="toolbar" aria-label={`${SIDE_LABEL[side]} (collapsed)`} className="wm-rail-tools">
        {bar.views.length === 0
          ? <button
              type="button"
              className="wm-rail-button"
              title={`Show ${SIDE_LABEL[side].toLowerCase()}`}
              aria-label={`Show ${SIDE_LABEL[side].toLowerCase()}`}
              onClick={() => set({ collapsed: false })}
            >
              <Icon icon={EXPAND_ICON[side]} />
            </button>
          : bar.views.map(viewId => {
              const view = byId.get(viewId)
              return (
                <button
                  key={viewId}
                  type="button"
                  className={`wm-rail-button${viewId === bar.activeView ? ' wm-rail-active' : ''}`}
                  title={view?.title ?? viewId}
                  aria-label={view?.title ?? viewId}
                  data-view-icon-for={viewId}
                  onClick={() => set({ collapsed: false, activeView: viewId })}
                >
                  <Icon icon={view?.icon ?? 'circle-filled'} />
                </button>
              )
            })}
    </div>
  )
}

/** One tab per present view, the collapse button at the end. */
function TabStrip({ side, bar, set }: {
  side: BarSide
  bar: BarState
  set(change: Omit<LayoutSlotSetRequest, 'slot'>): void
}) {
  const { byId } = useViewCatalogue()

  return (
    <div className="wm-tab-strip">
      <div role="tablist" aria-label={SIDE_LABEL[side]} className="wm-tabs">
        {bar.views.map(viewId => {
          const view = byId.get(viewId)
          return (
            <button
              key={viewId}
              type="button"
              role="tab"
              aria-selected={viewId === bar.activeView}
              className={`wm-tab${viewId === bar.activeView ? ' wm-tab-active' : ''}`}
              onClick={() => set({ activeView: viewId })}
            >
              <Icon icon={view?.icon} />
              <span className="wm-tab-title">{view?.title ?? viewId}</span>
            </button>
          )
        })}
      </div>
      <button
        type="button"
        className="wm-collapse"
        title={`Hide ${SIDE_LABEL[side].toLowerCase()}`}
        aria-label={`Hide ${SIDE_LABEL[side].toLowerCase()}`}
        onClick={() => set({ collapsed: true })}
      >
        <Icon icon={COLLAPSE_ICON[side]} />
      </button>
    </div>
  )
}

/**
 * The bar's views. Only the active one is visible; a tab that has been shown
 * stays mounted (hidden) so its state survives switching, and a tab that has
 * never been shown is not loaded at all.
 */
export function BarViews({ bar }: { bar: { views: readonly string[], activeView?: string } }) {
  const { byId, componentFor } = useViewCatalogue()
  const shown = useRef(new Set<string>())
  if (bar.activeView !== undefined) shown.current.add(bar.activeView)

  return (
    <>
      {bar.views
        .filter(viewId => shown.current.has(viewId))
        .map(viewId => {
          const view = byId.get(viewId)
          if (!view) return null
          return <ViewHost key={viewId} view={view} componentFor={componentFor} hidden={viewId !== bar.activeView} />
        })}
    </>
  )
}

/**
 * The resize handle on a bar's inner edge. Dragging previews locally and sends
 * one request on release; arrow keys move by 10 px; double-click restores the
 * default size.
 */
function Splitter({ side, size, onPreview, onCommit }: {
  side: BarSide
  size: number
  onPreview(size: number | null): void
  onCommit(size: number): void
}) {
  const drag = useRef<{ start: number, size: number } | null>(null)
  const horizontal = side === 'top' || side === 'bottom'

  const sizeFrom = (position: number) => {
    if (!drag.current) return size
    const delta = position - drag.current.start
    const grows = side === 'left' || side === 'top' ? delta : -delta
    return Math.max(0, drag.current.size + grows)
  }

  return (
    <div
      className={`wm-splitter wm-splitter-${side}`}
      role="separator"
      aria-orientation={horizontal ? 'horizontal' : 'vertical'}
      aria-label={`Resize ${SIDE_LABEL[side].toLowerCase()}`}
      aria-valuenow={Math.round(size)}
      tabIndex={0}
      onPointerDown={event => {
        drag.current = { start: horizontal ? event.clientY : event.clientX, size }
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }}
      onPointerMove={event => {
        if (!drag.current) return
        onPreview(sizeFrom(horizontal ? event.clientY : event.clientX))
      }}
      onPointerUp={event => {
        if (!drag.current) return
        const next = sizeFrom(horizontal ? event.clientY : event.clientX)
        drag.current = null
        onCommit(next)
      }}
      onDoubleClick={() => onCommit(DEFAULT_BAR_SIZE[side])}
      onKeyDown={event => {
        if (event.key === GROW_KEY[side]) onCommit(size + 10)
        else if (event.key === SHRINK_KEY[side]) onCommit(Math.max(0, size - 10))
      }}
    />
  )
}

/** The arrow that makes a bar larger points away from its window edge. */
const GROW_KEY: Record<BarSide, string> = { left: 'ArrowRight', right: 'ArrowLeft', top: 'ArrowDown', bottom: 'ArrowUp' }
const SHRINK_KEY: Record<BarSide, string> = { left: 'ArrowLeft', right: 'ArrowRight', top: 'ArrowUp', bottom: 'ArrowDown' }
