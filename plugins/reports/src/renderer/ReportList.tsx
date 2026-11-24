// The Reports tab (left bar): every report offered, under its group, then the ledger's saved reports under My
// Reports. Clicking one shows it in the report view, through the same command the Reports menu runs. A report that
// can't be shown now is greyed, saying why. A saved report's context menu (and F2, Delete) renames, duplicates or
// deletes it, through the commands the view's ⋯ menu runs; not in a ledger open read-only.
import { KeyboardEvent, MouseEvent, useRef, useState } from 'react'
import { REPORTS_CHANNELS, REPORTS_COMMANDS as C, REPORTS_EVENTS, type ReportRef, type ReportsCatalog } from '@tessera/reports-api'
import { Alert, Box, Divider, Icon, ListItemIcon, ListItemText, Menu, MenuItem, Stack, Tooltip, Typography } from '@tessera/ui'
import { runCommand, useFollowed } from './bridge'

interface Entry {
  key: string
  ref: ReportRef
  label: string
  /** The tooltip: a report's description, a saved report's basis, or why it can't be shown. */
  detail: string
  enabled: boolean
}

const keyOf = (ref: ReportRef) => 'savedId' in ref ? `saved:${ref.savedId}` : `definition:${ref.definitionId}`

export default function ReportList() {
  const catalog = useFollowed<ReportsCatalog | null>(REPORTS_CHANNELS.catalog, REPORTS_EVENTS.catalog)
  const [error, setError] = useState<string>()
  const [focus, setFocus] = useState<string>()
  const [menu, setMenu] = useState<{ entry: Entry, top: number, left: number }>()
  const refs = useRef(new Map<string, HTMLElement>())
  if (!catalog) return null
  const readOnly = catalog.readOnly

  const sections: { id: string, label: string, entries: Entry[] }[] = catalog.groups.map(g => ({
    id: g.id, label: g.label,
    entries: catalog.definitions.filter(d => d.group === g.id).map(d => ({
      key: keyOf({ definitionId: d.id }), ref: { definitionId: d.id }, label: d.label,
      detail: d.enabled ? d.description : d.reason ?? `${d.description} Not available now.`, enabled: d.enabled
    }))
  }))
  if (catalog.saved.length > 0) {
    sections.push({
      id: 'saved', label: 'My Reports',
      entries: catalog.saved.map(s => ({
        key: keyOf({ savedId: s.id }), ref: { savedId: s.id }, label: s.name,
        detail: s.available ? s.basis : s.reason ?? 'Not available now.', enabled: s.available
      }))
    })
  }
  const entries = sections.flatMap(s => s.entries)
  const shownKey = catalog.shown ? keyOf(catalog.shown.ref) : undefined
  const current = focus ?? shownKey ?? entries.find(e => e.enabled)?.key

  const show = (entry: Entry) => {
    if (!entry.enabled) return
    setError(undefined)
    runCommand(C.show, entry.ref).catch(err => setError(String(err?.message ?? err)))
  }
  /** A saved report's own actions name it: cancelling one on a report not shown leaves the view as it was. */
  const act = (command: string, entry: Entry) => {
    setMenu(undefined)
    if (!('savedId' in entry.ref)) return
    setError(undefined)
    runCommand(command, { id: entry.ref.savedId }).catch(err => setError(String(err?.message ?? err)))
  }
  const onContextMenu = (event: MouseEvent, entry: Entry) => {
    event.preventDefault()
    setFocus(entry.key)
    setMenu({ entry, top: event.clientY, left: event.clientX })
  }
  const onKeyDown = (event: KeyboardEvent) => {
    const index = entries.findIndex(e => e.key === current)
    const go = (entry: Entry | undefined) => { if (entry) { setFocus(entry.key); refs.current.get(entry.key)?.focus() } }
    const handled = (() => {
      switch (event.key) {
        case 'ArrowDown': go(entries[index + 1]); return true
        case 'ArrowUp': go(entries[index - 1]); return true
        case 'Home': go(entries[0]); return true
        case 'End': go(entries[entries.length - 1]); return true
        case 'Enter': case ' ': { const entry = entries[index]; if (entry) show(entry); return true }
        case 'F2': { const entry = entries[index]; if (entry && 'savedId' in entry.ref && !readOnly) act(C.rename, entry); return entry !== undefined }
        case 'Delete': { const entry = entries[index]; if (entry && 'savedId' in entry.ref && !readOnly) act(C.deleteSaved, entry); return entry !== undefined }
        default: return false
      }
    })()
    if (handled) event.preventDefault()
  }

  return (
    <Stack sx={{ height: '100%' }} data-reports-page="list">
      {error && <Alert severity="error" sx={{ mx: 1, mt: 1 }}>{error}</Alert>}
      <Box role="listbox" aria-label={`Reports for ${catalog.ledgerName}`} onKeyDown={onKeyDown} sx={{ flex: 1, overflow: 'auto', py: 0.5 }}>
        {sections.map(section => (
          <Box key={section.id} role="group" aria-labelledby={`reports-group-${section.id}`}>
            <Typography
              id={`reports-group-${section.id}`} variant="overline" color="text.secondary" component="div"
              sx={{ px: 1.5, pt: 1, lineHeight: 2 }}
            >
              {section.label}
            </Typography>
            {section.entries.map(entry => {
              const selected = entry.key === shownKey
              return (
                <Tooltip key={entry.key} title={entry.detail} placement="right" enterDelay={600}>
                  <Box
                    ref={(element: HTMLElement | null) => { if (element) refs.current.set(entry.key, element); else refs.current.delete(entry.key) }}
                    role="option" aria-selected={selected} aria-disabled={!entry.enabled} aria-label={entry.label}
                    tabIndex={entry.key === current ? 0 : -1} data-report={entry.key}
                    onClick={() => { setFocus(entry.key); show(entry) }}
                    onContextMenu={event => { if ('savedId' in entry.ref) onContextMenu(event, entry) }}
                    sx={{
                      px: 1.5, py: 0.5, cursor: 'default', borderRadius: 1, bgcolor: selected ? 'action.selected' : undefined,
                      color: entry.enabled ? undefined : 'text.disabled',
                      '&:hover': { bgcolor: selected ? 'action.selected' : 'action.hover' },
                      '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: -2 }
                    }}
                  >
                    <Typography variant="body2" noWrap sx={{ fontWeight: selected ? 600 : undefined }}>{entry.label}</Typography>
                  </Box>
                </Tooltip>
              )
            })}
          </Box>
        ))}
      </Box>
      <Menu open={menu !== undefined} onClose={() => setMenu(undefined)} anchorReference="anchorPosition" anchorPosition={menu && { top: menu.top, left: menu.left }}>
        {menu && [
          <MenuItem key="show" disabled={!menu.entry.enabled} onClick={() => { setMenu(undefined); show(menu.entry) }}>
            <ListItemIcon><Icon name="ShowChart" fontSize="small" /></ListItemIcon><ListItemText>Show Report</ListItemText>
          </MenuItem>,
          <Divider key="divider" />,
          <MenuItem key="rename" disabled={readOnly} onClick={() => act(C.rename, menu.entry)}>
            <ListItemIcon><Icon name="Edit" fontSize="small" /></ListItemIcon><ListItemText secondary="F2">Rename…</ListItemText>
          </MenuItem>,
          <MenuItem key="duplicate" disabled={readOnly || !menu.entry.enabled} onClick={() => act(C.duplicate, menu.entry)}>
            <ListItemIcon><Icon name="ContentCopy" fontSize="small" /></ListItemIcon><ListItemText>Duplicate…</ListItemText>
          </MenuItem>,
          <MenuItem key="delete" disabled={readOnly} onClick={() => act(C.deleteSaved, menu.entry)}>
            <ListItemIcon><Icon name="Delete" fontSize="small" /></ListItemIcon><ListItemText secondary="Delete">Delete…</ListItemText>
          </MenuItem>
        ]}
      </Menu>
    </Stack>
  )
}
