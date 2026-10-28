import type { Border, BorderState } from '@tessera/types'
import { SLOT_FOR_SIDE, barHasContent } from '../../../shared/layout/types'
import type { ViewDescriptor } from '../../../shared/views/types'
import { useBar, useLayoutActions } from '../state/ShellState'
import { ViewPane, useViewCatalogue } from '../views/ViewsProvider'
import { BarIcon } from './BarIcon'
import { useBarItemCatalogue } from './BarItemsProvider'
import { ItemStrip } from './ItemStrip'
import { Splitter } from './Splitter'
import { useEverShown } from './useEverShown'

const LANDMARK = { top: 'header', bottom: 'footer', left: 'aside', right: 'aside' } as const
const vertical = (side: Border) => side === 'left' || side === 'right'
const label = (side: Border) => `${side[0].toUpperCase()}${side.slice(1)} bar`

interface PresentView {
  id: string
  /** Undefined while the catalogue entry is still in flight. */
  view?: ViewDescriptor
}

/**
 * One side of the frame. Renders nothing when nothing is present in it, a
 * rail of icons when it is collapsed, and its items, tabs and active view
 * otherwise. Which views and items are present, and which view is active, is
 * the controller's to decide; this only draws them and reports gestures.
 * `size` is the size to draw: the controller's, or where the bar is being dragged to.
 */
export function Bar({ side, size, onDrag, onResize }: {
  side: Border
  size: number
  onDrag(side: Border, size: number): void
  onResize(side: Border, size: number): void
}) {
  const bar = useBar(side)
  const catalogue = useViewCatalogue()
  const itemCatalogue = useBarItemCatalogue()
  const { setSlot } = useLayoutActions()
  const expanded = !bar.collapsed
  const shown = useEverShown(bar.activeView, expanded)

  if (!barHasContent(bar)) return null

  const slot = SLOT_FOR_SIDE[side]
  const Landmark = LANDMARK[side]
  const views: PresentView[] = bar.views.map(id => ({ id, view: catalogue?.find(v => v.id === id) }))
  const items = bar.items.flatMap(id => itemCatalogue.find(item => item.id === id) ?? [])
  const strip = expanded && items.length > 0 ? <ItemStrip side={side} items={items} /> : null

  return (
    <Landmark aria-label={label(side)} tabIndex={-1} data-bar={side} data-region={side} data-state={expanded ? 'expanded' : 'collapsed'}
      style={{ gridArea: side, position: 'relative', display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
      {side !== 'bottom' && strip}

      {!expanded && (
        <Rail side={side} activeView={bar.activeView} views={views}
          onChoose={activeView => setSlot({ slot, activeView, collapsed: false })}
          onExpand={() => setSlot({ slot, collapsed: false })} />
      )}

      {expanded && views.length > 0 && (
        <div role="tablist" aria-label={`${label(side)} views`} style={{ display: 'flex', flex: 'none', alignItems: 'center' }}>
          {views.map(({ id, view }) => (
            <button key={id} role="tab" id={`tab-${id}`} aria-selected={id === bar.activeView} aria-controls={`panel-${id}`}
              onClick={() => setSlot({ slot, activeView: id })}>
              {view && <BarIcon icon={view.icon} title={view.title} />} {view?.title ?? id}
            </button>
          ))}
          <button aria-label={`Collapse ${label(side).toLowerCase()}`} style={{ marginLeft: 'auto' }}
            onClick={() => setSlot({ slot, collapsed: true })}>
            ×
          </button>
        </div>
      )}

      {/* Views that have been shown stay mounted while the bar is collapsed or another tab is chosen. */}
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', display: expanded ? 'block' : 'none' }}>
        {views.filter(({ id }) => shown.has(id)).map(({ id, view }) => (
          <div key={id} role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} hidden={id !== bar.activeView}>
            {view ? <ViewPane view={view} /> : <p>Loading…</p>}
          </div>
        ))}
      </div>

      {side === 'bottom' && strip}

      {expanded && views.length > 0 && (
        <Splitter side={side} size={size} onDrag={dragged => onDrag(side, dragged)} onCommit={committed => onResize(side, committed)} />
      )}
    </Landmark>
  )
}

/** A collapsed bar: one icon per view (a single expand button when it holds none), to bring it back. */
function Rail({ side, activeView, views, onChoose, onExpand }: {
  side: Border
  activeView?: BorderState['activeView']
  views: PresentView[]
  onChoose(viewId: string): void
  onExpand(): void
}) {
  return (
    <div role="toolbar" aria-label={`${label(side)} (collapsed)`} aria-orientation={vertical(side) ? 'vertical' : 'horizontal'}
      style={{ display: 'flex', flexDirection: vertical(side) ? 'column' : 'row', alignItems: 'center', gap: 4, padding: 4 }}>
      {views.length === 0
        ? <button aria-label={`Expand ${label(side).toLowerCase()}`} onClick={onExpand}>»</button>
        : views.map(({ id, view }) => (
          <button key={id} aria-label={view?.title ?? id} title={view?.title ?? id}
            aria-current={id === activeView || undefined} onClick={() => onChoose(id)}>
            {view ? <BarIcon icon={view.icon} title={view.title} /> : '…'}
          </button>
        ))}
    </div>
  )
}
