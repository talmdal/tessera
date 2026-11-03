import { Box, IconButton, Stack, Tab, Tabs, Tooltip, Typography } from '@mui/material'
import type { Border, BorderState } from '@tessera/types'
import { ContributionIcon, Icon } from '@tessera/ui'
import type { IconName } from '@tessera/ui'
import { SLOT_FOR_SIDE, barHasContent } from '../../../shared/layout/types'
import type { ViewDescriptor } from '../../../shared/views/types'
import { useBar, useLayoutActions } from '../state/ShellState'
import { ViewPane, useViewCatalogue } from '../views/ViewsProvider'
import { useBarItemCatalogue } from './BarItemsProvider'
import { ItemStrip } from './ItemStrip'
import { Splitter } from './Splitter'
import { useEverShown } from './useEverShown'

const LANDMARK = { top: 'header', bottom: 'footer', left: 'aside', right: 'aside' } as const
const vertical = (side: Border) => side === 'left' || side === 'right'
const label = (side: Border) => `${side[0].toUpperCase()}${side.slice(1)} bar`

/** The edge of a bar that faces the main area, where its border and its splitter go. */
const INNER_EDGE = { left: 'borderRight', right: 'borderLeft', top: 'borderBottom', bottom: 'borderTop' } as const

/** The icon that expands an empty collapsed bar points the way it will grow. */
const EXPAND_ICON: Record<Border, IconName> = { left: 'ChevronRight', right: 'ChevronLeft', top: 'ExpandMore', bottom: 'ExpandLess' }

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
  const views: PresentView[] = bar.views.map(id => ({ id, view: catalogue?.find(v => v.id === id) }))
  const items = bar.items.flatMap(id => itemCatalogue.find(item => item.id === id) ?? [])
  const strip = expanded && items.length > 0 ? <ItemStrip side={side} items={items} /> : null

  return (
    <Box component={LANDMARK[side]} aria-label={label(side)} tabIndex={-1}
      data-bar={side} data-region={side} data-state={expanded ? 'expanded' : 'collapsed'}
      sx={theme => ({
        gridArea: side,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
        bgcolor: expanded ? theme.tessera.bar.background : theme.tessera.bar.railBackground,
        [INNER_EDGE[side]]: 1,
        borderStyle: 'solid',
        borderColor: 'divider',
        outline: 'none'
      })}>
      {side !== 'bottom' && strip}

      {!expanded && (
        <Rail side={side} activeView={bar.activeView} views={views}
          onChoose={activeView => setSlot({ slot, activeView, collapsed: false })}
          onExpand={() => setSlot({ slot, collapsed: false })} />
      )}

      {expanded && views.length > 0 && (
        <Stack direction="row" sx={{ alignItems: 'center', flex: 'none', borderBottom: 1, borderColor: theme => theme.tessera.bar.tabStripBorder }}>
          <Tabs value={bar.activeView ?? false} onChange={(_event, activeView: string) => setSlot({ slot, activeView })}
            aria-label={`${label(side)} views`} variant="scrollable" scrollButtons="auto" sx={{ flex: 1, minWidth: 0 }}>
            {views.map(({ id, view }) => (
              <Tab key={id} value={id} id={`tab-${id}`} aria-controls={`panel-${id}`} iconPosition="start"
                icon={view ? <ContributionIcon icon={view.icon} title={view.title} fontSize="small" /> : undefined}
                label={view?.title ?? id} />
            ))}
          </Tabs>
          <Tooltip title={`Collapse ${label(side).toLowerCase()}`}>
            <IconButton aria-label={`Collapse ${label(side).toLowerCase()}`} onClick={() => setSlot({ slot, collapsed: true })} sx={{ mx: 1 }}>
              <Icon name="Close" fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      )}

      {/* Views that have been shown stay mounted while the bar is collapsed or another tab is chosen. */}
      <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', display: expanded ? 'block' : 'none' }}>
        {views.filter(({ id }) => shown.has(id)).map(({ id, view }) => (
          <div key={id} role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} hidden={id !== bar.activeView}>
            {view ? <ViewPane view={view} /> : <Typography sx={{ p: 2 }} color="text.secondary">Loading…</Typography>}
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

/** A collapsed bar: one icon per view (a single expand button when it holds none), to bring it back. */
function Rail({ side, activeView, views, onChoose, onExpand }: {
  side: Border
  activeView?: BorderState['activeView']
  views: PresentView[]
  onChoose(viewId: string): void
  onExpand(): void
}) {
  const expandLabel = `Expand ${label(side).toLowerCase()}`
  return (
    <Stack role="toolbar" aria-label={`${label(side)} (collapsed)`} aria-orientation={vertical(side) ? 'vertical' : 'horizontal'}
      direction={vertical(side) ? 'column' : 'row'} spacing={1} sx={{ alignItems: 'center', p: 1 }}>
      {views.length === 0
        ? (
          <Tooltip title={expandLabel} placement={vertical(side) ? 'right' : 'bottom'}>
            <IconButton aria-label={expandLabel} onClick={onExpand}>
              <Icon name={EXPAND_ICON[side]} fontSize="small" />
            </IconButton>
          </Tooltip>
        )
        : views.map(({ id, view }) => (
          <Tooltip key={id} title={view?.title ?? id} placement={vertical(side) ? 'right' : 'bottom'}>
            <IconButton aria-label={view?.title ?? id} aria-current={id === activeView || undefined} onClick={() => onChoose(id)}
              sx={theme => ({
                color: id === activeView ? 'text.primary' : 'text.secondary',
                // The active view's icon carries a mark on the bar's outer edge, as an activity bar does.
                boxShadow: id === activeView ? `inset ${vertical(side) ? '2px 0' : '0 2px'} 0 ${theme.tessera.bar.railIndicator}` : 'none',
                borderRadius: 1
              })}>
              {view ? <ContributionIcon icon={view.icon} title={view.title} fontSize="small" /> : '…'}
            </IconButton>
          </Tooltip>
        ))}
    </Stack>
  )
}
