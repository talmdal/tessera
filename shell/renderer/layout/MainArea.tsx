import type { ReactNode } from 'react'
import { Box } from '@tessera/ui'
import { Loading } from '../Loading'
import { useLayout } from '../state/ShellState'
import { ViewPane, useViewCatalogue } from '../views/ViewsProvider'
import { useEverShown } from './useEverShown'

/**
 * The centre of the frame: the one active main view, chosen by the controller,
 * or `fallback` when no view targets it. Views shown once stay mounted, hidden.
 */
export function MainArea({ fallback }: { fallback: ReactNode }) {
  const { main } = useLayout()
  const catalogue = useViewCatalogue()
  const shown = useEverShown(main.activeView, true)

  return (
    <Box component="main" aria-label="Main" tabIndex={-1} data-region="main" sx={{ gridArea: 'main', minWidth: 0, minHeight: 0, overflow: 'auto', p: 2.5 }}>
      {main.views.length === 0 && fallback}
      {main.views.filter(id => shown.has(id)).map(id => {
        const view = catalogue?.find(v => v.id === id)
        return view
          ? <ViewPane key={id} view={view} hidden={id !== main.activeView} />
          : <div key={id} hidden={id !== main.activeView}><Loading>Loading…</Loading></div>
      })}
    </Box>
  )
}
