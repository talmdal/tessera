// The Budgets tab (left bar): the ledger's budgets, with what each covers. Clicking one shows it in the budget view;
// everything else runs a command, as the Budget menu does.
import { KeyboardEvent, MouseEvent, useRef, useState } from 'react'
import { BUDGET_CHANNELS, BUDGET_COMMANDS as C, BUDGET_EVENTS, type BudgetsView, type BudgetSummary } from '@tessera/budget-api'
import { Alert, Box, Divider, Icon, IconButton, ListItemIcon, ListItemText, Menu, MenuItem, Stack, Toolbar, Tooltip, Typography } from '@tessera/ui'
import { runCommand, useFollowed } from './bridge'

export default function BudgetList() {
  const view = useFollowed<BudgetsView | null>(BUDGET_CHANNELS.budgets, BUDGET_EVENTS.budgets)
  const [menu, setMenu] = useState<{ id: string, top: number, left: number }>()
  const [error, setError] = useState<string>()
  const refs = useRef(new Map<string, HTMLElement>())
  if (!view) return null
  const { budgets, readOnly } = view
  const shown = budgets.find(b => b.id === view.shown)

  const run = (command: string, args?: unknown) => {
    setMenu(undefined)
    setError(undefined)
    runCommand(command, ...(args === undefined ? [] : [args])).catch(err => setError(String(err?.message ?? err)))
  }
  const show = (budget: BudgetSummary) => run(C.show, { id: budget.id })
  // A budget's own actions name it: cancelling Delete on a budget not shown leaves the view as it was
  const act = (command: string, budget: BudgetSummary) => run(command, { id: budget.id })

  const onKeyDown = (event: KeyboardEvent) => {
    if (!shown) return
    const index = budgets.indexOf(shown)
    const go = (budget: BudgetSummary | undefined) => { if (budget) { show(budget); refs.current.get(budget.id)?.focus() } }
    const handled = (() => {
      switch (event.key) {
        case 'ArrowDown': go(budgets[index + 1]); return true
        case 'ArrowUp': go(budgets[index - 1]); return true
        case 'Home': go(budgets[0]); return true
        case 'End': go(budgets[budgets.length - 1]); return true
        case 'Enter': run(C.show, { id: shown.id }); return true
        case 'F2': if (!readOnly) act(C.properties, shown); return true
        case 'Delete': if (!readOnly) act(C.deleteBudget, shown); return true
        case 'Insert': if (!readOnly) run(C.newBudget); return true
        default: return false
      }
    })()
    if (handled) event.preventDefault()
  }
  const onContextMenu = (event: MouseEvent, budget: BudgetSummary) => {
    event.preventDefault()
    setMenu({ id: budget.id, top: event.clientY, left: event.clientX })
  }
  const target = budgets.find(b => b.id === menu?.id)

  return (
    <Stack sx={{ height: '100%' }} data-budget-page="list">
      <Toolbar variant="dense" disableGutters sx={{ px: 1, gap: 0.5, minHeight: 36, justifyContent: 'flex-end' }}>
        <Tooltip title="New budget (Insert)">
          <span><IconButton size="small" aria-label="New budget" onClick={() => run(C.newBudget)} disabled={readOnly}><Icon name="Add" /></IconButton></span>
        </Tooltip>
      </Toolbar>
      {error && <Alert severity="error" sx={{ mx: 1 }}>{error}</Alert>}
      {budgets.length === 0
        ? <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 1 }}>
            {readOnly ? (view.archive ? 'No budgets in this archive.' : 'No budgets in this ledger.') : 'No budgets yet. Make one with New Budget….'}
          </Typography>
        : (
          <Box role="listbox" aria-label={`Budgets in ${view.ledgerName}`} onKeyDown={onKeyDown} sx={{ flex: 1, overflow: 'auto', py: 0.5 }}>
            {budgets.map(budget => {
              const selected = budget.id === shown?.id
              return (
                <Box
                  key={budget.id}
                  ref={(element: HTMLElement | null) => { if (element) refs.current.set(budget.id, element); else refs.current.delete(budget.id) }}
                  role="option" aria-selected={selected} aria-label={budget.name} tabIndex={selected ? 0 : -1}
                  title={`${budget.covers} · ${budget.currency}`}
                  onClick={() => show(budget)}
                  onContextMenu={event => onContextMenu(event, budget)}
                  sx={{
                    px: 1.5, py: 0.5, cursor: 'default', borderRadius: 1, bgcolor: selected ? 'action.selected' : undefined,
                    '&:hover': { bgcolor: selected ? 'action.selected' : 'action.hover' },
                    '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: -2 }
                  }}
                >
                  <Typography variant="body2" noWrap sx={{ fontWeight: selected ? 600 : undefined }}>{budget.name}</Typography>
                  <Typography variant="caption" color="text.secondary" noWrap component="div">{budget.covers} · {budget.currency}</Typography>
                </Box>
              )
            })}
          </Box>
        )}
      <Menu open={menu !== undefined && target !== undefined} onClose={() => setMenu(undefined)} anchorReference="anchorPosition" anchorPosition={menu && { top: menu.top, left: menu.left }}>
        {target && [
          <MenuItem key="show" onClick={() => show(target)}><ListItemIcon><Icon name="List" fontSize="small" /></ListItemIcon><ListItemText>Show Budget</ListItemText></MenuItem>,
          <Divider key="divider" />,
          <MenuItem key="properties" disabled={readOnly} onClick={() => act(C.properties, target)}><ListItemIcon><Icon name="Edit" fontSize="small" /></ListItemIcon><ListItemText>Properties…</ListItemText></MenuItem>,
          <MenuItem key="duplicate" disabled={readOnly} onClick={() => act(C.duplicate, target)}><ListItemIcon><Icon name="ContentCopy" fontSize="small" /></ListItemIcon><ListItemText>Duplicate…</ListItemText></MenuItem>,
          <MenuItem key="delete" disabled={readOnly} onClick={() => act(C.deleteBudget, target)}><ListItemIcon><Icon name="Delete" fontSize="small" /></ListItemIcon><ListItemText>Delete…</ListItemText></MenuItem>
        ]}
      </Menu>
    </Stack>
  )
}
