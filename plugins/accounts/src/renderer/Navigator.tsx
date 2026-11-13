// The Accounts navigator (left bar): the open book, its sub-books and their accounts, with balances. It replaces
// the book's own panel. Everything it does runs a command, so the Accounts menu, this view and its context menu
// share one set of rules and confirmations. Clicking an account shows its register; the arrow keys only move the
// selection (Enter shows the register, F2 edits).
import { KeyboardEvent, MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  ACCOUNTS_CHANNELS, ACCOUNTS_COMMANDS as C, ACCOUNTS_EVENTS, ACCOUNT_TYPE_LABELS, formatAmount, maskAccountNumber,
  shownBalance, showsAvailable,
  type Chart, type CurrencyTotals, type ReconcileActionArgs, type ResolvedNavigatorItem, type ResolvedReconcileAction,
  type Selection
} from '@tessera/accounts-api'
import {
  Box, Checkbox, Chip, Divider, Icon, IconButton, ListItemIcon, ListItemText, Menu, MenuItem, Stack, Toolbar, Tooltip, Typography
} from '@tessera/ui'
import { runCommand, useFollowed } from './bridge'
import { Balance, Totals, TYPE_ICONS } from './display'

export interface Row {
  /** `book`, or the sub-book's or account's id. */
  key: string
  kind: 'book' | 'subBook' | 'account'
  id?: string
  name: string
  depth: number
  hasChildren: boolean
  parentKey?: string
  icon: string
  closed?: boolean
  totals?: CurrencyTotals
  /** `available`: the balance shown is the one above the account's minimum. */
  balance?: { minor: number, currency: string, available?: boolean }
  detail?: string
}

const BOOK_KEY = 'book'

/** The tree in display order: under each node, its sub-books (with their contents), then its accounts. */
export function rowsOf(chart: Chart, options: { collapsed: ReadonlySet<string>, showClosed: boolean }): Row[] {
  const accounts = chart.accounts.filter(({ account }) => options.showClosed || !account.closed)
  const hasContent = (id: string | null): boolean =>
    chart.subBooks.some(s => s.parentId === id) || accounts.some(({ account }) => account.subBookId === id)

  const rows: Row[] = [{
    key: BOOK_KEY, kind: 'book', name: chart.book.name, depth: 0, hasChildren: hasContent(null), icon: 'AccountBalance', totals: chart.totals
  }]
  const visit = (parentId: string | null, parentKey: string, depth: number) => {
    if (options.collapsed.has(parentKey)) return
    for (const sub of chart.subBooks.filter(s => s.parentId === parentId).sort((a, b) => a.order - b.order)) {
      rows.push({ key: sub.id, kind: 'subBook', id: sub.id, name: sub.name, depth, hasChildren: hasContent(sub.id), parentKey, icon: 'Folder', totals: sub.totals })
      visit(sub.id, sub.id, depth + 1)
    }
    for (const { account, balances } of accounts.filter(({ account }) => account.subBookId === parentId)) {
      const available = showsAvailable(account)
      rows.push({
        key: account.id, kind: 'account', id: account.id, name: account.name, depth, hasChildren: false, parentKey,
        icon: TYPE_ICONS[account.type], closed: account.closed,
        balance: { minor: shownBalance(account, balances), currency: account.currency, available },
        detail: [
          ACCOUNT_TYPE_LABELS[account.type], account.institution, maskAccountNumber(account.accountNumber),
          account.minimumBalance !== undefined
            ? `balance ${formatAmount(balances.current, account.currency)}, minimum ${formatAmount(account.minimumBalance, account.currency)}${available ? ', showing what is above it' : ''}`
            : undefined,
          account.closed ? 'closed' : undefined
        ].filter(Boolean).join(' · ')
      })
    }
  }
  visit(null, BOOK_KEY, 1)
  return rows
}

/**
 * A row another plugin contributed (`accounts.navigator.items`). It runs a command and never becomes the
 * navigator's selection, so the Accounts menu's enablement is unaffected by it. It sits outside the tree and is a
 * button, not a tree node: it is no part of the book's structure, and inside the tree it could not be reached by
 * keyboard, since the arrow keys walk the chart's rows.
 */
function ContributedRow({ item, onRun }: { item: ResolvedNavigatorItem, onRun(command: string): void }) {
  const tone = item.badgeTone === 'default' ? undefined : item.badgeTone
  return (
    <Box
      role="button" aria-label={item.label} aria-disabled={!item.enabled || undefined}
      tabIndex={item.enabled ? 0 : -1} title={item.description} data-navigator-item={item.id}
      onClick={() => { if (item.enabled) onRun(item.command) }}
      onKeyDown={event => {
        if ((event.key === 'Enter' || event.key === ' ') && item.enabled) { event.preventDefault(); onRun(item.command) }
      }}
      sx={{
        display: 'flex', alignItems: 'center', gap: 0.5, pl: 0.5, pr: 1, py: 0.25, cursor: 'default', borderRadius: 1,
        color: item.enabled ? undefined : 'text.disabled',
        '&:hover': { bgcolor: item.enabled ? 'action.hover' : undefined },
        '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: -2 }
      }}
    >
      <Box component="span" aria-hidden sx={{ display: 'inline-flex', width: 20 }} />
      {item.icon && !item.icon.startsWith('./') && <Icon name={item.icon} fontSize="small" />}
      <Typography variant="body2" noWrap sx={{ flex: 1 }}>{item.label}</Typography>
      {item.badge !== undefined && (
        <Chip size="small" label={item.badge} color={tone} variant={tone ? 'filled' : 'outlined'}
          sx={{ height: 18, '& .MuiChip-label': { px: 0.75, fontSize: '0.7rem' } }} />
      )}
    </Box>
  )
}

const selectionOf = (row: Row): Selection => row.kind === 'book' ? { kind: 'book' } : { kind: row.kind, id: row.id! }
const keyOf = (selection: Selection | undefined) => !selection || selection.kind === 'book' ? BOOK_KEY : selection.id

export default function Navigator() {
  const chart = useFollowed<Chart | null>(ACCOUNTS_CHANNELS.chart, ACCOUNTS_EVENTS.chart)
  const announced = useFollowed<Selection>(ACCOUNTS_CHANNELS.selection, ACCOUNTS_EVENTS.selection)
  const [selected, setSelected] = useState(BOOK_KEY)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [showClosed, setShowClosed] = useState(false)
  const [menu, setMenu] = useState<{ anchor?: HTMLElement, position?: { top: number, left: number } }>()
  const [error, setError] = useState<string>()
  // The selected account's reconciliation options, for its context menu
  const [actions, setActions] = useState<ResolvedReconcileAction[]>([])
  // Rows other plugins add (`accounts.navigator.items`), e.g. Recurring with its overdue badge
  const items = useFollowed<ResolvedNavigatorItem[]>(ACCOUNTS_CHANNELS.navigatorItems, ACCOUNTS_EVENTS.navigatorItems) ?? []
  const rowRefs = useRef(new Map<string, HTMLElement>())

  const rows = useMemo(() => chart ? rowsOf(chart, { collapsed, showClosed }) : [], [chart, collapsed, showClosed])
  const row = rows.find(r => r.key === selected) ?? rows[0]

  /** Selects a row here and tells the plugin, whose commands act on the selection. */
  const select = (key: string): Promise<void> => {
    setSelected(key)
    const target = rows.find(r => r.key === key)
    if (!target) return Promise.resolve()
    return window.api.invoke(ACCOUNTS_CHANNELS.select, selectionOf(target)).then(() => undefined, err => setError(String(err?.message ?? err)))
  }

  // A command selected something (a new account): show it, opening its branch and closed accounts if need be
  useEffect(() => {
    if (!announced || !chart) return
    const key = keyOf(announced)
    setSelected(key)
    const account = chart.accounts.find(s => s.account.id === key)?.account
    if (account?.closed) setShowClosed(true)
    const parents = new Set<string>()
    for (let at = account ? account.subBookId : chart.subBooks.find(s => s.id === key)?.parentId ?? null; at !== null;
      at = chart.subBooks.find(s => s.id === at)?.parentId ?? null) parents.add(at)
    setCollapsed(current => new Set([...current].filter(k => !parents.has(k) && k !== BOOK_KEY)))
  }, [announced, chart])

  // Whatever was selected may have gone (deleted, or hidden with closed accounts)
  useEffect(() => {
    if (chart && !rows.some(r => r.key === selected)) select(rows[0]?.key ?? BOOK_KEY)
  }, [rows, selected, chart])

  if (!chart || !row) return null

  const focus = (key: string) => { select(key); rowRefs.current.get(key)?.focus() }

  const run = (command: string, args?: unknown) => {
    setMenu(undefined)
    setError(undefined)
    runCommand(command, ...(args === undefined ? [] : [args])).catch(err => setError(String(err?.message ?? err)))
  }
  const edit = () => {
    if (row.kind === 'account') run(C.editAccount, { id: row.id })
    else if (row.kind === 'subBook') run(C.renameSubBook, { id: row.id })
  }
  const openRegister = (target: Row = row) => { if (target.kind === 'account') run(C.showRegister, { id: target.id }) }
  /** Shows the account's register first: reconciling happens there. */
  const reconcileWith = (action: ResolvedReconcileAction) => {
    if (row.kind !== 'account' || !row.id) return
    const args: ReconcileActionArgs = { accountId: row.id }
    setMenu(undefined)
    runCommand(C.showRegister, { id: row.id })
      .then(() => runCommand(action.command, args))
      .catch(err => setError(String(err?.message ?? err)))
  }
  const remove = () => {
    if (row.kind === 'account') run(C.deleteAccount, { id: row.id })
    else if (row.kind === 'subBook') run(C.deleteSubBook, { id: row.id })
  }

  const toggle = (key: string, open?: boolean) => setCollapsed(current => {
    const next = new Set(current)
    if (open ?? next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  const onKeyDown = (event: KeyboardEvent) => {
    const index = rows.indexOf(row)
    const handled = (() => {
      switch (event.key) {
        case 'ArrowDown': if (index < rows.length - 1) focus(rows[index + 1].key); return true
        case 'ArrowUp': if (index > 0) focus(rows[index - 1].key); return true
        case 'Home': focus(rows[0].key); return true
        case 'End': focus(rows[rows.length - 1].key); return true
        case 'ArrowRight':
          if (row.hasChildren && collapsed.has(row.key)) toggle(row.key, true)
          else if (row.hasChildren && rows[index + 1]) focus(rows[index + 1].key)
          return true
        case 'ArrowLeft':
          if (row.hasChildren && !collapsed.has(row.key)) toggle(row.key, false)
          else if (row.parentKey) focus(row.parentKey)
          return true
        case 'Enter': if (row.kind === 'account') openRegister(); else edit(); return true
        case 'F2': edit(); return true
        case 'Delete': remove(); return true
        case 'Insert': run(C.newAccount); return true
        case 'ContextMenu': openMenuAt(rowRefs.current.get(row.key)); return true
        default:
          if (event.key === 'F10' && event.shiftKey) { openMenuAt(rowRefs.current.get(row.key)); return true }
          return false
      }
    })()
    if (handled) event.preventDefault()
  }

  const loadActions = (target: Row) => {
    setActions([])
    if (target.kind !== 'account' || target.closed) return
    window.api.invoke<ResolvedReconcileAction[]>(ACCOUNTS_CHANNELS.reconcileActions, { accountId: target.id, scope: 'account' })
      .then(found => setActions(found ?? []), () => setActions([]))
  }
  const openMenuAt = (anchor?: HTMLElement) => { if (anchor) { loadActions(row); setMenu({ anchor }) } }
  const onContextMenu = (event: MouseEvent, target: Row) => {
    event.preventDefault()
    select(target.key)
    loadActions(target)
    setMenu({ position: { top: event.clientY, left: event.clientX } })
  }

  const isAccount = row.kind === 'account'
  const isSub = row.kind === 'subBook'

  return (
    <Stack sx={{ height: '100%' }} data-accounts-page="navigator">
      <Toolbar variant="dense" disableGutters sx={{ px: 1, gap: 0.5, minHeight: 36, justifyContent: 'flex-end' }}>
        <Tooltip title="New account (Insert)">
          <IconButton size="small" aria-label="New account" onClick={() => run(C.newAccount)}><Icon name="Add" /></IconButton>
        </Tooltip>
        <Tooltip title="New sub-book">
          <IconButton size="small" aria-label="New sub-book" onClick={() => run(C.newSubBook)}><Icon name="LibraryAdd" /></IconButton>
        </Tooltip>
        <Tooltip title={isSub ? 'Rename (F2)' : 'Edit (F2)'}>
          <span><IconButton size="small" aria-label={isSub ? 'Rename sub-book' : 'Edit account'} onClick={edit} disabled={!(isSub || (isAccount && !row.closed))}><Icon name="Edit" /></IconButton></span>
        </Tooltip>
        <Tooltip title="Delete (Delete)">
          <span><IconButton size="small" aria-label={isSub ? 'Delete sub-book' : 'Delete account'} onClick={remove} disabled={!(isSub || isAccount)}><Icon name="Delete" /></IconButton></span>
        </Tooltip>
        <Tooltip title="More">
          <IconButton size="small" aria-label="More actions" aria-haspopup="menu" onClick={event => { loadActions(row); setMenu({ anchor: event.currentTarget }) }}><Icon name="MoreVert" /></IconButton>
        </Tooltip>
      </Toolbar>
      {error && <Typography role="alert" color="error" variant="body2" sx={{ px: 1 }}>{error}</Typography>}

      <Box sx={{ flex: 1, overflow: 'auto', py: 0.5 }}>
        {items.filter(i => i.placement === 'top').map(i => <ContributedRow key={i.id} item={i} onRun={run} />)}

        <Box role="tree" aria-label={`Accounts in ${chart.book.name}`} onKeyDown={onKeyDown}>
        {rows.map(r => {
          const isSelected = r.key === row.key
          const open = !collapsed.has(r.key)
          return (
            <Box
              key={r.key}
              ref={(element: HTMLElement | null) => { if (element) rowRefs.current.set(r.key, element); else rowRefs.current.delete(r.key) }}
              role="treeitem"
              aria-level={r.depth + 1}
              aria-selected={isSelected}
              aria-expanded={r.hasChildren ? open : undefined}
              aria-label={r.name}
              tabIndex={isSelected ? 0 : -1}
              title={r.detail}
              // The register follows once the plugin has the selection, which the command acts on
              onClick={() => { void select(r.key).then(() => openRegister(r)) }}
              onDoubleClick={() => { if (r.kind === 'subBook') edit() }}
              onContextMenu={event => onContextMenu(event, r)}
              data-closed={r.closed || undefined}
              sx={{
                display: 'flex', alignItems: 'center', gap: 0.5, pl: 0.5 + r.depth * 2, pr: 1, py: 0.25, cursor: 'default',
                borderRadius: 1, bgcolor: isSelected ? 'action.selected' : undefined,
                color: r.closed ? 'text.disabled' : undefined,
                '&:hover': { bgcolor: isSelected ? 'action.selected' : 'action.hover' },
                '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: -2 }
              }}
            >
              <Box component="span" aria-hidden
                onClick={event => { event.stopPropagation(); if (r.hasChildren) toggle(r.key) }}
                sx={{ display: 'inline-flex', width: 20, visibility: r.hasChildren ? 'visible' : 'hidden' }}>
                <Icon name={open ? 'ExpandMore' : 'ChevronRight'} fontSize="small" />
              </Box>
              <Icon name={r.icon} fontSize="small" />
              <Typography variant="body2" noWrap sx={{ flex: 1, fontWeight: r.kind === 'book' ? 600 : undefined }}>{r.name}</Typography>
              <Typography variant="body2" component="span">
                {r.balance
                  ? <>
                      {r.balance.available && <Box component="span" sx={{ color: 'text.secondary', fontSize: '0.75em', mr: 0.5 }} aria-label="available">avail.</Box>}
                      <Balance minor={r.balance.minor} currency={r.balance.currency} muted={r.closed} />
                    </>
                  : r.totals && <Totals totals={r.totals} muted />}
              </Typography>
            </Box>
          )
        })}
        </Box>

        {items.filter(i => i.placement !== 'top').map(i => <ContributedRow key={i.id} item={i} onRun={run} />)}
      </Box>

      <Menu
        open={menu !== undefined}
        onClose={() => setMenu(undefined)}
        {...(menu?.position ? { anchorReference: 'anchorPosition' as const, anchorPosition: menu.position } : { anchorEl: menu?.anchor })}
      >
        <MenuItem onClick={() => run(C.newAccount)}><ListItemIcon><Icon name="Add" fontSize="small" /></ListItemIcon><ListItemText>New Account…</ListItemText></MenuItem>
        <MenuItem onClick={() => run(C.newSubBook)}><ListItemIcon><Icon name="LibraryAdd" fontSize="small" /></ListItemIcon><ListItemText>New Sub-Book…</ListItemText></MenuItem>
        <Divider />
        {isAccount && <MenuItem onClick={() => openRegister()}><ListItemIcon><Icon name="List" fontSize="small" /></ListItemIcon><ListItemText>Open Register</ListItemText></MenuItem>}
        {isAccount && !row.closed && actions.map(action => (
          <MenuItem key={action.id} onClick={() => reconcileWith(action)} title={action.description}>
            <ListItemIcon>{action.icon && !action.icon.startsWith('./') && <Icon name={action.icon} fontSize="small" />}</ListItemIcon>
            <ListItemText>{action.label}</ListItemText>
          </MenuItem>
        ))}
        {isAccount && !row.closed && <MenuItem onClick={edit}><ListItemIcon><Icon name="Edit" fontSize="small" /></ListItemIcon><ListItemText>Edit Account…</ListItemText></MenuItem>}
        {isAccount && !row.closed && <MenuItem onClick={() => run(C.closeAccount, { id: row.id })}><ListItemIcon><Icon name="Block" fontSize="small" /></ListItemIcon><ListItemText>Close Account…</ListItemText></MenuItem>}
        {isAccount && row.closed && <MenuItem onClick={() => run(C.reopenAccount, { id: row.id })}><ListItemIcon><Icon name="Check" fontSize="small" /></ListItemIcon><ListItemText>Reopen Account</ListItemText></MenuItem>}
        {isSub && <MenuItem onClick={edit}><ListItemIcon><Icon name="Edit" fontSize="small" /></ListItemIcon><ListItemText>Rename Sub-Book…</ListItemText></MenuItem>}
        {(isAccount || isSub) && <MenuItem onClick={() => run(C.move, { kind: row.kind, id: row.id })}><ListItemIcon><Icon name="ChevronRight" fontSize="small" /></ListItemIcon><ListItemText>Move To…</ListItemText></MenuItem>}
        {(isAccount || isSub) && <MenuItem onClick={remove}><ListItemIcon><Icon name="Delete" fontSize="small" /></ListItemIcon><ListItemText>{isSub ? 'Delete Sub-Book…' : 'Delete Account…'}</ListItemText></MenuItem>}
        {(isAccount || isSub) && <Divider />}
        <MenuItem onClick={() => { setShowClosed(value => !value); setMenu(undefined) }} role="menuitemcheckbox" aria-checked={showClosed}>
          <ListItemIcon><Checkbox size="small" checked={showClosed} tabIndex={-1} disableRipple sx={{ p: 0 }} /></ListItemIcon>
          <ListItemText>Show closed accounts</ListItemText>
        </MenuItem>
      </Menu>
    </Stack>
  )
}
