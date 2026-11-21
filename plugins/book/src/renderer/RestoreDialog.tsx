// File › Restore from Backup…: pick a backup, and whether it replaces the open book or becomes a new one.
// See docs/backup-restore-design.md, "Restore".
//
// The dialog only chooses. The command does the rest in the main process: it reads the chosen file's header again
// (nothing said here is trusted), asks where a new book goes, confirms, and restores.
import { useEffect, useMemo, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import {
  BOOK_CHANNELS, type BackupInfo, type BackupTrigger, type RestoreDialogInput, type RestoreDialogResult
} from '@tessera/book-api'
import {
  Alert, Box, Button, CircularProgress, DialogActions, DialogContent, Divider, FormControlLabel, List, ListItemButton,
  ListItemText, Radio, RadioGroup, Stack, Typography
} from '@tessera/ui'
import { whenText } from './bridge'

const TRIGGER: Record<BackupTrigger, string> = { auto: 'automatic', manual: 'made by you', 'pre-restore': 'before a restore', archive: 'archive' }
const ENGINE: Record<string, string> = { 'storage-sqlite': 'SQLite', 'storage-loki': 'LokiJS', 'storage-memory': 'memory' }

/** "2.1 MB", "640 KB". */
export function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

const fileName = (file: string) => file.split(/[\\/]/).filter(Boolean).pop() ?? file

interface Group { key: string, title: string, items: BackupInfo[] }

/**
 * Backups grouped by book, newest first in each: the open book's group first, then the others by their newest
 * backup, then files that can't be read. A backup picked with Browse… heads its own group.
 */
export function groupBackups(listed: readonly BackupInfo[], openId: string | undefined, chosen: BackupInfo | undefined): Group[] {
  const archives = listed.filter(info => info.header?.trigger === 'archive')
  const backups = listed.filter(info => info.header?.trigger !== 'archive')
  const books = new Map<string, Group>()
  const unreadable: BackupInfo[] = []
  for (const info of backups) {
    if (chosen && info.file === chosen.file) continue
    if (!info.header) { unreadable.push(info); continue }
    const group = books.get(info.header.bookId) ?? { key: info.header.bookId, title: info.header.bookName, items: [] }
    group.items.push(info)
    books.set(info.header.bookId, group)
  }
  const archiveItems = archives.filter(info => !chosen || info.file !== chosen.file)
  const newest = (g: Group) => Date.parse(g.items[0]?.header?.takenAt ?? '') || 0
  const ordered = [...books.values()].sort((a, b) => (a.key === openId ? -1 : b.key === openId ? 1 : newest(b) - newest(a)))
  return [
    ...(chosen ? [{ key: 'chosen', title: 'Chosen file', items: [chosen] }] : []),
    ...(archiveItems.length > 0 ? [{ key: 'archives', title: 'Archives', items: archiveItems }] : []),
    ...ordered,
    ...(unreadable.length > 0 ? [{ key: 'unreadable', title: 'Files that can’t be read', items: unreadable }] : [])
  ]
}

function BackupRow({ info, selected, onSelect }: { info: BackupInfo, selected: boolean, onSelect(): void }) {
  const { header, problem } = info
  const primary = header ? `${whenText(header.takenAt)} · ${TRIGGER[header.trigger]}` : fileName(info.file)
  const secondary = problem ?? (header && `${sizeText(info.sizeBytes)} · ${header.documents.toLocaleString()} items`)
  return (
    <ListItemButton
      selected={selected} disabled={problem !== undefined} onClick={onSelect} dense title={info.file}
      aria-label={`${header ? `${header.bookName}, ${primary}` : primary}${problem ? ` — ${problem}` : ''}`}>
      <ListItemText primary={primary} secondary={secondary}
        slotProps={{ secondary: { color: problem ? 'error' : 'text.secondary' } }} />
    </ListItemButton>
  )
}

export default function RestoreDialog({ input, close }: DialogProps<RestoreDialogInput, RestoreDialogResult>) {
  const [listed, setListed] = useState<BackupInfo[]>()
  const [chosen, setChosen] = useState<BackupInfo>()
  const [selectedFile, setSelectedFile] = useState<string>()
  const [target, setTarget] = useState<'replace' | 'new'>('new')
  const [error, setError] = useState<string>()

  useEffect(() => {
    let live = true
    window.api.invoke<BackupInfo[]>(BOOK_CHANNELS.backupsList,
      input.archiveFolder ? { folder: input.folder, archiveFolder: input.archiveFolder } : { folder: input.folder }).then(
      found => { if (live) setListed(found) },
      err => { if (live) { setListed([]); setError(`The backups couldn’t be listed: ${err instanceof Error ? err.message : String(err)}`) } })
    return () => { live = false }
  }, [input.folder, input.archiveFolder])

  const groups = useMemo(() => groupBackups(listed ?? [], input.open?.id, chosen), [listed, input.open?.id, chosen])
  const all = useMemo(() => groups.flatMap(g => g.items), [groups])
  const selected = all.find(info => info.file === selectedFile)

  const browse = async () => {
    setError(undefined)
    try {
      const picked = await window.api.invoke<BackupInfo | undefined>(BOOK_CHANNELS.backupsChoose)
      if (!picked) return
      setChosen(picked)
      setSelectedFile(picked.file)
    } catch (err) {
      setError(`The backup couldn’t be chosen: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const canReplace = input.open !== undefined && !input.open.readOnly
  const otherBook = canReplace && selected?.header && selected.header.bookId !== input.open!.id ? selected.header.bookName : undefined
  const ready = selected !== undefined && selected.problem === undefined && (target === 'new' || canReplace)

  return (
    <>
      <DialogContent>
        <Stack sx={{ gap: 2, pt: 0.5 }}>
          <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
            <Typography variant="body2" sx={{ flex: 1, wordBreak: 'break-all' }} data-testid="restore-folder">
              Backups in {input.folder}
              {input.archiveFolder && ` · Archives in ${input.archiveFolder}`}
            </Typography>
            <Button size="small" variant="outlined" onClick={() => { void browse() }}>Browse…</Button>
          </Stack>

          {error && <Alert severity="error">{error}</Alert>}

          <Box sx={{ maxHeight: 300, overflowY: 'auto', border: 1, borderColor: 'divider', borderRadius: 1 }}>
            {listed === undefined
              ? <Stack sx={{ p: 2, alignItems: 'center' }}><CircularProgress size={24} aria-label="Looking for backups" /></Stack>
              : groups.length === 0
                ? <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                    There are no backups in this folder. Use Browse… to choose one somewhere else.
                  </Typography>
                : groups.map(group => (
                  <Box key={group.key} role="group" aria-label={group.title}>
                    <Typography variant="subtitle2" sx={{ px: 2, pt: 1 }}>{group.title}</Typography>
                    <List dense disablePadding>
                      {group.items.map(info => (
                        <BackupRow key={info.file} info={info} selected={info.file === selectedFile} onSelect={() => setSelectedFile(info.file)} />
                      ))}
                    </List>
                  </Box>
                ))}
          </Box>

          {selected?.header && (
            <Typography variant="body2" data-testid="restore-selected">
              {selected.header.bookName}, taken {whenText(selected.header.takenAt)} by {selected.header.app} ({ENGINE[selected.header.engine] ?? selected.header.engine})
            </Typography>
          )}

          <Divider />

          <RadioGroup value={target} onChange={event => setTarget(event.target.value as 'replace' | 'new')} aria-label="Restore to">
            <FormControlLabel value="replace" disabled={!canReplace} control={<Radio size="small" />} sx={{ alignItems: 'flex-start' }}
              label={
                <Stack>
                  <Typography variant="body2">
                    {input.open ? `Replace the open book, “${input.open.name}”` : 'Replace the open book'}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {!input.open
                      ? 'No book is open.'
                      : input.open.readOnly
                        ? 'It is read-only, so it can’t be replaced.'
                        : 'A backup of it is made first, and its file is moved to the Trash.'}
                  </Typography>
                  {otherBook && target === 'replace' && (
                    <Typography variant="caption" color="warning.main" data-testid="restore-other-book">
                      This backup is of “{otherBook}”, not “{input.open!.name}”.
                    </Typography>
                  )}
                </Stack>
              } />
            <FormControlLabel value="new" control={<Radio size="small" />} sx={{ alignItems: 'flex-start' }}
              label={
                <Stack>
                  <Typography variant="body2">Restore as a new book…</Typography>
                  <Typography variant="caption" color="text.secondary">
                    You choose where to save it. {input.open ? `“${input.open.name}” is not changed.` : ''}
                  </Typography>
                </Stack>
              } />
          </RadioGroup>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close()}>Cancel</Button>
        <Button variant="contained" disabled={!ready}
          onClick={() => { if (selected) close({ file: selected.file, target }) }}>Restore…</Button>
      </DialogActions>
    </>
  )
}
