// Saved Import Choices: everything imports remember, in one place. Which account each source's statements go to; the
// payee names learnt from the bank's text; and what each source's files taught (a CSV file's columns, a QIF file's
// dates, whether to take a file's categories, amounts read the other way round). Each can be changed or forgotten, at
// once: a forgotten choice is asked about, or worked out, afresh with the source's next file.
// See docs/import-formats-design.md, "Phase F6: remembered choices".
import { useCallback, useEffect, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import {
  IMPORT_CHANNELS,
  type CategorySource, type ImportResult, type PayeeAliasView, type RememberedChoice, type SavedLinks
} from '@tessera/import-api'
import {
  Alert, Box, Button, Checkbox, DialogActions, DialogContent, MenuItem, Tab, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, Tabs, TextField, Typography
} from '@tessera/ui'
import { showDate } from './display'

type TabId = 'accounts' | 'payees' | 'files'

/** Calls the import plugin; a failure is given back as its message. */
async function call<T>(channel: string, data?: unknown): Promise<{ value?: T, error?: string }> {
  try {
    const result = await window.api.invoke<ImportResult<T>>(channel, data)
    return result.ok ? { value: result.value } : { error: result.error.message }
  } catch (err) {
    return { error: String((err as Error)?.message ?? err) }
  }
}

const Empty = ({ children }: { children: string }) => <Typography color="text.secondary" sx={{ py: 2 }}>{children}</Typography>

function Accounts({ data, act }: { data: SavedLinks, act: (channel: string, body: unknown) => void }) {
  if (data.links.length === 0) return <Empty>No saved account matches yet. They are saved as you import, when you choose an account for a statement.</Empty>
  return (
    <TableContainer>
      <Table size="small" aria-label="Saved account matches">
        <TableHead>
          <TableRow>
            <TableCell>Statements from</TableCell>
            <TableCell>Go to</TableCell>
            <TableCell>Ask every time</TableCell>
            <TableCell>Last used</TableCell>
            <TableCell />
          </TableRow>
        </TableHead>
        <TableBody>
          {data.links.map(link => {
            const open = data.accounts.some(a => a.id === link.accountId)
            return (
              <TableRow key={link.id}>
                <TableCell>
                  <Typography>{link.label}</Typography>
                  {link.formatLabel && <Typography variant="body2" color="text.secondary">{link.formatLabel}</Typography>}
                </TableCell>
                <TableCell sx={{ minWidth: 200 }}>
                  <TextField select size="small" fullWidth value={link.accountId}
                    slotProps={{ select: { SelectDisplayProps: { 'aria-label': `Account for ${link.label}` } as object } }}
                    onChange={event => act(IMPORT_CHANNELS.updateLink, { id: link.id, accountId: event.target.value })}>
                    {!open && <MenuItem value={link.accountId} disabled>{link.accountName} (closed)</MenuItem>}
                    {data.accounts.map(a => <MenuItem key={a.id} value={a.id} dense>{a.name}</MenuItem>)}
                  </TextField>
                </TableCell>
                <TableCell>
                  <Checkbox size="small" checked={!link.autoApply} slotProps={{ input: { 'aria-label': `Ask every time for ${link.label}` } }}
                    onChange={event => act(IMPORT_CHANNELS.updateLink, { id: link.id, autoApply: !event.target.checked })} />
                </TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>{showDate(link.lastUsedAt.slice(0, 10))}</TableCell>
                <TableCell align="right">
                  <Button size="small" aria-label={`Forget ${link.label}`} onClick={() => act(IMPORT_CHANNELS.forgetLink, { id: link.id })}>Forget</Button>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </TableContainer>
  )
}

function Payees({ data, act }: { data: PayeeAliasView[], act: (channel: string, body: unknown) => void }) {
  if (data.length === 0) return <Empty>No payee names learnt yet. They are learnt as you accept matches, and choose transactions for bank lines.</Empty>
  return (
    <TableContainer>
      <Table size="small" aria-label="Payee names">
        <TableHead>
          <TableRow>
            <TableCell>The bank writes</TableCell>
            <TableCell>Payee</TableCell>
            <TableCell>Used</TableCell>
            <TableCell />
          </TableRow>
        </TableHead>
        <TableBody>
          {data.map(alias => (
            <TableRow key={alias.id}>
              <TableCell sx={{ typography: 'monospace' }}>{alias.bankText}</TableCell>
              <TableCell>{alias.payeeName}</TableCell>
              <TableCell>{alias.uses === 0 ? 'Not yet' : `${alias.uses} ${alias.uses === 1 ? 'time' : 'times'}`}</TableCell>
              <TableCell align="right">
                <Button size="small" aria-label={`Forget ${alias.bankText}`} onClick={() => act(IMPORT_CHANNELS.forgetAlias, { id: alias.id })}>Forget</Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  )
}

const CATEGORY_CHOICES: { value: CategorySource, label: string }[] = [
  { value: 'file', label: 'The file\'s categories' }, { value: 'payee', label: 'My usual category for each payee' }
]

function Files({ data, act }: { data: RememberedChoice[], act: (channel: string, body: unknown) => void }) {
  if (data.length === 0) return <Empty>Nothing remembered about any file yet.</Empty>
  return (
    <TableContainer>
      <Table size="small" aria-label="What imports remember about each source">
        <TableHead>
          <TableRow>
            <TableCell>What</TableCell>
            <TableCell>For</TableCell>
            <TableCell>Remembered</TableCell>
            <TableCell />
          </TableRow>
        </TableHead>
        <TableBody>
          {data.map(choice => (
            <TableRow key={choice.id}>
              <TableCell>
                <Typography>{choice.what}</Typography>
                <Typography variant="body2" color="text.secondary">{choice.owner}</Typography>
              </TableCell>
              <TableCell>{choice.source}</TableCell>
              <TableCell sx={{ minWidth: 220 }}>
                {choice.categories ? (
                  <TextField select size="small" fullWidth value={choice.categories}
                    slotProps={{ select: { SelectDisplayProps: { 'aria-label': `Categories for ${choice.source}` } as object } }}
                    onChange={event => act(IMPORT_CHANNELS.updateRemembered, { id: choice.id, categories: event.target.value })}>
                    {CATEGORY_CHOICES.map(c => <MenuItem key={c.value} value={c.value} dense>{c.label}</MenuItem>)}
                  </TextField>
                ) : choice.detail}
              </TableCell>
              <TableCell align="right">
                <Button size="small" aria-label={`Forget ${choice.what} for ${choice.source}`} onClick={() => act(IMPORT_CHANNELS.forgetRemembered, { id: choice.id })}>
                  Forget
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  )
}

export default function SavedChoicesDialog({ close }: DialogProps<Record<string, never>, void>) {
  const [tab, setTab] = useState<TabId>('accounts')
  const [links, setLinks] = useState<SavedLinks>()
  const [aliases, setAliases] = useState<PayeeAliasView[]>()
  const [remembered, setRemembered] = useState<RememberedChoice[]>()
  const [error, setError] = useState<string>()

  const load = useCallback(async () => {
    const [l, a, r] = await Promise.all([
      call<SavedLinks>(IMPORT_CHANNELS.links), call<PayeeAliasView[]>(IMPORT_CHANNELS.aliases), call<RememberedChoice[]>(IMPORT_CHANNELS.remembered)
    ])
    setError(l.error ?? a.error ?? r.error)
    if (l.value) setLinks(l.value)
    if (a.value) setAliases(a.value)
    if (r.value) setRemembered(r.value)
  }, [])
  useEffect(() => { void load() }, [load])

  /** Changes or forgets something, then shows what is remembered now. */
  const act = (channel: string, body: unknown) => {
    void call<void>(channel, body).then(async result => {
      await load()
      if (result.error) setError(result.error)
    })
  }

  const count = (n: number | undefined) => n === undefined ? '' : ` (${n})`
  return (
    <>
      <DialogContent>
        <Typography sx={{ mb: 1 }}>
          What Tessera remembers from your imports, for this ledger. Change or forget anything here: a forgotten choice is
          asked about, or worked out again, with the next file it applies to.
        </Typography>
        <Tabs value={tab} onChange={(_, value: TabId) => setTab(value)} aria-label="Saved import choices">
          <Tab value="accounts" label={`Accounts${count(links?.links.length)}`} />
          <Tab value="payees" label={`Payees${count(aliases?.length)}`} />
          <Tab value="files" label={`Files and choices${count(remembered?.length)}`} />
        </Tabs>
        {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
        <Box role="tabpanel" aria-label={tab === 'accounts' ? 'Accounts' : tab === 'payees' ? 'Payees' : 'Files and choices'} sx={{ mt: 1, minHeight: 240 }}>
          {tab === 'accounts' && links && <Accounts data={links} act={act} />}
          {tab === 'payees' && aliases && <Payees data={aliases} act={act} />}
          {tab === 'files' && remembered && <Files data={remembered} act={act} />}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={() => close()} autoFocus>Close</Button>
      </DialogActions>
    </>
  )
}
