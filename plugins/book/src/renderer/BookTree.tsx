// The left-bar view of the open book and its sub-books. Everything it does runs the book's commands, so the
// menus, this view and (later) the accounts navigator share one set of rules and confirmations.
import { KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  BOOK_CHANNELS, BOOK_COMMANDS, BOOK_EVENTS, flattenTree, type BookTree as Tree, type NewBookDialogResult
} from '@tessera/book-api'
import { Box, Icon, IconButton, Stack, Toolbar, Tooltip, Typography } from '@tessera/ui'
import { runCommand, useFollowed } from './bridge'

/** The book itself, as a row. */
const ROOT = ''

interface Row {
  id: string
  name: string
  depth: number
  hasChildren: boolean
  parent?: string
}

export function rowsOf(tree: Tree, collapsed: ReadonlySet<string>): Row[] {
  const rootOpen = !collapsed.has(ROOT)
  const expanded = new Set(tree.subBooks.map(s => s.id).filter(id => !collapsed.has(id)))
  const rows: Row[] = [{ id: ROOT, name: tree.book.name, depth: 0, hasChildren: tree.subBooks.length > 0 }]
  if (rootOpen) {
    for (const { subBook, depth, hasChildren } of flattenTree(tree.subBooks, { expanded })) {
      rows.push({ id: subBook.id, name: subBook.name, depth: depth + 1, hasChildren, parent: subBook.parentId ?? ROOT })
    }
  }
  return rows
}

export default function BookTree() {
  const tree = useFollowed<Tree | null>(BOOK_CHANNELS.tree, BOOK_EVENTS.tree)
  const [selected, setSelected] = useState(ROOT)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string>()
  const rowRefs = useRef(new Map<string, HTMLElement>())

  const rows = useMemo(() => tree ? rowsOf(tree, collapsed) : [], [tree, collapsed])

  // A selected sub-book that was deleted (or hidden in a collapsed branch) gives way to the book
  useEffect(() => {
    if (!rows.some(row => row.id === selected)) setSelected(ROOT)
  }, [rows, selected])

  if (!tree) return null

  const focus = (id: string) => { setSelected(id); rowRefs.current.get(id)?.focus() }
  const isSub = selected !== ROOT

  const attempt = (work: () => Promise<unknown>) => {
    setError(undefined)
    work().catch(err => setError(String(err?.message ?? err)))
  }
  const newSubBook = () => attempt(async () => {
    const result = await runCommand<NewBookDialogResult | undefined>(BOOK_COMMANDS.new, { parentId: isSub ? selected : null })
    if (result?.kind === 'subBook') {
      setCollapsed(current => { const next = new Set(current); next.delete(selected); return next })
      setSelected(result.id)
    }
  })
  const rename = () => { if (isSub) attempt(() => runCommand(BOOK_COMMANDS.renameSubBook, { id: selected })) }
  const remove = () => { if (isSub) attempt(() => runCommand(BOOK_COMMANDS.deleteSubBook, { id: selected })) }

  const toggle = (id: string, open?: boolean) => setCollapsed(current => {
    const next = new Set(current)
    if (open ?? next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const onKeyDown = (event: KeyboardEvent) => {
    const index = rows.findIndex(row => row.id === selected)
    const row = rows[index]
    if (!row) return
    const handled = (() => {
      switch (event.key) {
        case 'ArrowDown': if (index < rows.length - 1) focus(rows[index + 1].id); return true
        case 'ArrowUp': if (index > 0) focus(rows[index - 1].id); return true
        case 'Home': focus(rows[0].id); return true
        case 'End': focus(rows[rows.length - 1].id); return true
        case 'ArrowRight':
          if (row.hasChildren && collapsed.has(row.id)) toggle(row.id, true)
          else if (row.hasChildren && rows[index + 1]) focus(rows[index + 1].id)
          return true
        case 'ArrowLeft':
          if (row.hasChildren && !collapsed.has(row.id)) toggle(row.id, false)
          else if (row.parent !== undefined) focus(row.parent)
          return true
        case 'F2': rename(); return true
        case 'Delete': remove(); return true
        case 'Insert': newSubBook(); return true
        default: return false
      }
    })()
    if (handled) event.preventDefault()
  }

  return (
    <Stack sx={{ height: '100%' }} data-book-page="tree">
      {/* The book's name is the tree's first row, so the toolbar holds only the actions */}
      <Toolbar variant="dense" disableGutters sx={{ px: 1, gap: 0.5, minHeight: 36, justifyContent: 'flex-end' }}>
        <Tooltip title="New sub-book (Insert)">
          <IconButton size="small" aria-label="New sub-book" onClick={newSubBook}><Icon name="LibraryAdd" /></IconButton>
        </Tooltip>
        <Tooltip title="Rename (F2)">
          <span><IconButton size="small" aria-label="Rename sub-book" onClick={rename} disabled={!isSub}><Icon name="Edit" /></IconButton></span>
        </Tooltip>
        <Tooltip title="Delete (Delete)">
          <span><IconButton size="small" aria-label="Delete sub-book" onClick={remove} disabled={!isSub}><Icon name="Delete" /></IconButton></span>
        </Tooltip>
      </Toolbar>
      {error && <Typography role="alert" color="error" variant="body2" sx={{ px: 1 }}>{error}</Typography>}

      <Box role="tree" aria-label={`Book ${tree.book.name}`} onKeyDown={onKeyDown} sx={{ flex: 1, overflow: 'auto', py: 0.5 }}>
        {rows.map(row => {
          const isSelected = row.id === selected
          const open = !collapsed.has(row.id)
          return (
            <Box
              key={row.id || 'book'}
              ref={(element: HTMLElement | null) => { if (element) rowRefs.current.set(row.id, element); else rowRefs.current.delete(row.id) }}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={isSelected}
              aria-expanded={row.hasChildren ? open : undefined}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => setSelected(row.id)}
              onDoubleClick={() => { if (row.id !== ROOT) rename() }}
              sx={{
                display: 'flex', alignItems: 'center', gap: 0.5, pl: 0.5 + row.depth * 2, pr: 1, py: 0.25, cursor: 'default',
                borderRadius: 1, bgcolor: isSelected ? 'action.selected' : undefined,
                '&:hover': { bgcolor: isSelected ? 'action.selected' : 'action.hover' },
                '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: -2 }
              }}
            >
              <Box
                component="span"
                aria-hidden
                onClick={event => { event.stopPropagation(); if (row.hasChildren) toggle(row.id) }}
                sx={{ display: 'inline-flex', width: 20, visibility: row.hasChildren ? 'visible' : 'hidden' }}
              >
                <Icon name={open ? 'ExpandMore' : 'ChevronRight'} fontSize="small" />
              </Box>
              <Icon name={row.id === ROOT ? 'AccountBalance' : 'Folder'} fontSize="small" />
              <Typography variant="body2" noWrap sx={{ fontWeight: row.id === ROOT ? 600 : undefined }}>{row.name}</Typography>
            </Box>
          )
        })}
      </Box>
    </Stack>
  )
}
