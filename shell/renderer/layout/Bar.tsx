import type { Border, BorderState } from '@tessera/types'
import { Box, Icon, IconButton, Tab, Tabs } from '@tessera/ui'
import { SLOT_FOR_SIDE, barHasContent } from '../../../shared/layout/types'
import type { ViewDescriptor } from '../../../shared/views/types'
import { Loading } from '../Loading'
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

/** The edge a bar shares with the main area, which is where its divider goes. */
const INNER_EDGE = { left: 'borderRight', right: 'borderLeft', top: 'borderBottom', bottom: 'borderTop' } as const

/** Pointing away from the main area to collapse, towards it to expand. */
const COLLAPSE_ICON = { left: 'ChevronLeft', right: 'ChevronRight', top: 'ExpandLess', bottom: 'ExpandMore' } as const
const EXPAND_ICON = { left: 'ChevronRight', right: 'ChevronLeft', top: 'ExpandMore', bottom: 'ExpandLess' } as const

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
    <Box component={Landmark} aria-label={label(side)} tabIndex={-1} data-bar={side} data-region={side} data-state={expanded ? 'expanded' : 'collapsed'}
      sx={{
        gridArea: side, position: 'relative', display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'hidden',
        bgcolor: 'background.paper', [INNER_EDGE[side]]: 1, borderColor: 'divider'
      }}>
      {side !== 'bottom' && strip}

      {!expanded && (
        <Rail side={side} activeView={bar.activeView} views={views}
          onChoose={activeView => setSlot({ slot, activeView, collapsed: false })}
          onExpand={() => setSlot({ slot, collapsed: false })} />
      )}

      {expanded && views.length > 0 && (
        <Box sx={{ display: 'flex', flex: 'none', alignItems: 'center', borderBottom: 1, borderColor: 'divider' }}>
          <Tabs value={bar.activeView ?? false} onChange={(_event, activeView: string) => setSlot({ slot, activeView })}
            variant="scrollable" scrollButtons={false} aria-label={`${label(side)} views`} sx={{ flex: 1, minWidth: 0 }}>
            {views.map(({ id, view }) => (
              <Tab key={id} value={id} id={`tab-${id}`} aria-controls={`panel-${id}`} sx={SHRINKING_TAB}
                icon={view ? <BarIcon icon={view.icon} title={view.title} /> : undefined} iconPosition="start"
                label={<TabLabel text={view?.title ?? id} />} />
            ))}
          </Tabs>
          <IconButton aria-label={`Collapse ${label(side).toLowerCase()}`} title={`Collapse ${label(side).toLowerCase()}`}
            onClick={() => setSlot({ slot, collapsed: true })} sx={{ mx: 0.5 }}>
            <Icon name={COLLAPSE_ICON[side]} fontSize="small" />
          </IconButton>
        </Box>
      )}

      {/* Views that have been shown stay mounted while the bar is collapsed or another tab is chosen. */}
      <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', display: expanded ? 'block' : 'none' }}>
        {views.filter(({ id }) => shown.has(id)).map(({ id, view }) => (
          <div key={id} role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} hidden={id !== bar.activeView}>
            {view ? <ViewPane view={view} /> : <Loading>Loading…</Loading>}
          </div>
        ))}
      </Box>

      {side === 'bottom' && strip}

      {expanded && views.length > 0 && (
        <Splitter side={side} size={size} onDrag={dragged => onDrag(side, dragged)} onCommit={committed => onResize(side, committed)} />
      )}
    </Box>
  )
}

/**
 * Tabs that narrow when the strip is too short for them (a narrow bar, or large text), rather than sliding out of view
 * where nothing shows they are there: every tab stays visible, and its label is cut short with an ellipsis. Scroll
 * buttons were tried instead; MUI shows them on an overflow of a pixel, and the hidden start button's width then makes
 * the overflow real, so a strip that fitted kept its arrows (docs/font-roles-design.md, Phase 2 results).
 */
const SHRINKING_TAB = { minWidth: 0, flexShrink: 1 } as const

/** A tab's label, cut short with an ellipsis when the tab has narrowed, and then shown in full as its tooltip. */
function TabLabel({ text }: { text: string }) {
  return (
    <Box component="span" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      onMouseEnter={event => {
        const span = event.currentTarget
        span.title = span.scrollWidth > span.clientWidth ? text : ''
      }}>
      {text}
    </Box>
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
    <Box role="toolbar" aria-label={`${label(side)} (collapsed)`} aria-orientation={vertical(side) ? 'vertical' : 'horizontal'}
      sx={{ display: 'flex', flexDirection: vertical(side) ? 'column' : 'row', alignItems: 'center', gap: 0.5, p: 0.5 }}>
      {views.length === 0
        ? (
          <IconButton aria-label={`Expand ${label(side).toLowerCase()}`} title={`Expand ${label(side).toLowerCase()}`} onClick={onExpand}>
            <Icon name={EXPAND_ICON[side]} fontSize="small" />
          </IconButton>
        )
        : views.map(({ id, view }) => (
          <IconButton key={id} aria-label={view?.title ?? id} title={view?.title ?? id} color={id === activeView ? 'primary' : 'default'}
            aria-current={id === activeView || undefined} onClick={() => onChoose(id)}>
            {view ? <BarIcon icon={view.icon} title={view.title} /> : <Icon name="" fallback="…" fontSize="small" />}
          </IconButton>
        ))}
    </Box>
  )
}
