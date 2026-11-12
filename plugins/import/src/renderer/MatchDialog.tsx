// Change Match: which transaction a bank line is, chosen from the account's transactions near its date (best first,
// with what differs in words), or any of them by searching; or Unmatch, which makes the bank line a transaction of its
// own; or leaving the line out. The options depend on where the line stands. A line that looks already imported from
// another file starts on that transaction: choosing it says they are the same; adding it says they aren't. The list comes from the plugin
// (import:match.candidates); the plugin makes the change. See docs/import-manager-design.md, "The Change Match dialog".
import { FormEvent, useEffect, useMemo, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import { AMOUNT_COLUMNS, formatAmount, type Account } from '@tessera/accounts-api'
import {
  IMPORT_CHANNELS,
  type ChangeArgs, type ImportResult, type MatchCandidate, type MatchCandidatesRequest, type MatchCandidatesResponse, type MatchDialogResult
} from '@tessera/import-api'
import {
  Alert, Box, Button, Checkbox, CircularProgress, DialogActions, DialogContent, FormControlLabel, Icon, InputAdornment, Radio,
  RadioGroup, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography
} from '@tessera/ui'
import { showDate } from './display'

export const UNMATCH = '(unmatch)'
export const SKIP = '(skip)'
const chosen = (id: string) => `tx:${id}`

/** An amount as the register's columns show it: unsigned, the column saying which way. */
const unsigned = (minor: number, currency: string) => formatAmount(minor, currency, { sign: 'never', currency: false })

/** 'Payment 84.12', 'Deposit 3,000.00': the bank line's amount with its register column's name. */
function columnAmount(account: Account, minor: number): string {
  const columns = AMOUNT_COLUMNS[account.type]
  return `${minor < 0 ? columns.decrease : columns.increase} ${unsigned(minor, account.currency)}`
}

/** What Unmatch says, by where the line stands; undefined where it isn't offered (a row added as new). */
function unmatchLabel(data: MatchCandidatesResponse): string | undefined {
  switch (data.state) {
    case 'proposed': return 'Unmatch: keep my transaction as it is, and add the bank line as a new one'
    case 'unresolved': return 'Add the bank line as a new transaction'
    case 'duplicate': return 'It’s a different transaction: add the bank line as a new one'
    case 'accepted': {
      const back = [
        data.restores?.date !== undefined && showDate(data.restores.date),
        data.restores?.amount !== undefined && unsigned(data.restores.amount, data.account.currency)
      ].filter(Boolean)
      return back.length > 0
        ? `Unmatch: put my transaction back as it was (${back.join(', ')}), and add the bank line as a new one`
        : 'Unmatch: keep my transaction as it is now, and add the bank line as a new one'
    }
    default: return undefined
  }
}

const NOW: Record<MatchCandidatesResponse['state'], string> = {
  proposed: 'Proposed as a match for the transaction marked below, not yet accepted.',
  accepted: 'Matched to the transaction marked below.',
  new: 'Added as a new transaction.',
  unresolved: 'It lost its match: the transaction it was matched to was deleted, voided or reconciled.',
  duplicate: 'It looks like the transaction marked below, imported before from another file, so nothing was added for it.'
}

export default function MatchDialog({ input, close }: DialogProps<ChangeArgs, MatchDialogResult>) {
  const [query, setQuery] = useState('')
  const [whole, setWhole] = useState(false)
  const [data, setData] = useState<MatchCandidatesResponse>()
  const [error, setError] = useState<string>()
  const [choice, setChoice] = useState<string>()
  const [remember, setRemember] = useState<boolean>()
  const range: MatchCandidatesRequest['range'] = whole ? 'all' : query.trim() !== '' ? 'wide' : 'window'

  useEffect(() => {
    let live = true
    const request: MatchCandidatesRequest = { lineId: input.lineId, range, ...(query.trim() !== '' && { query: query.trim() }) }
    window.api.invoke<ImportResult<MatchCandidatesResponse>>(IMPORT_CHANNELS.matchCandidates, request).then(result => {
      if (!live) return
      if (!result.ok) { setError(result.error.message); return }
      setError(undefined)
      setData(result.value)
      // To begin with, the transaction the line is on now (none for a row added as new)
      setChoice(current => current ?? (result.value.currentId !== undefined && result.value.state !== 'new' ? chosen(result.value.currentId) : undefined))
    }, err => { if (live) setError(String((err as Error)?.message ?? err)) })
    return () => { live = false }
  }, [input.lineId, range, query])

  // The chosen transaction stays known while a search hides it from the list
  const [picked, setPicked] = useState<MatchCandidate>()
  const candidate = useMemo(() => {
    if (!choice?.startsWith('tx:')) return undefined
    const id = choice.slice(3)
    return data?.candidates.find(c => c.transaction.id === id) ?? (picked?.transaction.id === id ? picked : undefined)
  }, [choice, data, picked])

  if (!data) {
    return (
      <DialogContent>
        {error ? <Alert severity="error">{error}</Alert> : <Stack sx={{ alignItems: 'center', p: 2 }}><CircularProgress size={20} aria-label="Loading the transactions" /></Stack>}
        {error && <DialogActions><Button onClick={() => close()}>Close</Button></DialogActions>}
      </DialogContent>
    )
  }

  const { account, line, state } = data
  const unmatch = unmatchLabel(data)
  const isCurrent = candidate !== undefined && candidate.transaction.id === data.currentId
  const unchanged = state === 'accepted' && isCurrent
  // (Confirming a line already imported teaches nothing: it changes nothing)
  const learns = candidate !== undefined && !candidate.payeeKnown && data.bankName !== undefined && candidate.payeeName !== undefined && !unchanged
    && !(state === 'duplicate' && isCurrent)
  const rememberPayee = learns && (remember ?? true)

  const choose = (value: string) => {
    setChoice(value)
    setRemember(undefined)
    const id = value.startsWith('tx:') ? value.slice(3) : undefined
    setPicked(id !== undefined ? data.candidates.find(c => c.transaction.id === id) : undefined)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!choice || unchanged) return
    if (choice === UNMATCH) close({ kind: 'unmatch' })
    else if (choice === SKIP) close({ kind: 'skip' })
    else close({ kind: 'match', transactionId: choice.slice(3), rememberPayee })
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogContent>
        <Stack spacing={1.5}>
          <Box component="dl" sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 2, rowGap: 0.5, m: 0, '& dd': { m: 0 } }}>
            <Typography component="dt" color="text.secondary">Bank line</Typography>
            <Typography component="dd" data-testid="bank-line">
              {[showDate(line.date), line.payee, columnAmount(account, line.amount)].filter(Boolean).join(' · ')}
              {line.memo && <Typography component="span" color="text.secondary">{` (${line.memo})`}</Typography>}
            </Typography>
            <Typography component="dt" color="text.secondary">Now</Typography>
            <Typography component="dd">{NOW[state]}</Typography>
          </Box>
          {error && <Alert severity="error">{error}</Alert>}

          <RadioGroup aria-label="What the bank line is" value={choice ?? ''} onChange={event => choose(event.target.value)}>
            <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
              <Typography id="match-to">{state === 'new' ? 'It is one I entered:' : state === 'duplicate' ? 'It is the same as:' : 'Match it to:'}</Typography>
              <TextField
                size="small" placeholder="Search payee or amount" value={query} onChange={event => setQuery(event.target.value)}
                slotProps={{
                  htmlInput: { 'aria-label': 'Search payee or amount' },
                  input: { startAdornment: <InputAdornment position="start"><Icon name="Search" fontSize="small" /></InputAdornment> }
                }}
              />
            </Stack>
            <TableContainer sx={{ maxHeight: 280, border: 1, borderColor: 'divider', borderRadius: 1, mt: 1 }}>
              <Table size="small" stickyHeader aria-labelledby="match-to">
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox" />
                    <TableCell>Date</TableCell>
                    <TableCell>Payee</TableCell>
                    <TableCell>Category</TableCell>
                    <TableCell align="right">Amount</TableCell>
                    <TableCell>Differences</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.candidates.map(c => {
                    const t = c.transaction
                    const value = chosen(t.id)
                    const current = t.id === data.currentId
                    return (
                      <TableRow key={t.id} hover selected={choice === value} onClick={() => choose(value)} data-candidate={t.id} sx={{ cursor: 'default' }}>
                        <TableCell padding="checkbox">
                           <Radio size="small" value={value} slotProps={{ input: { 'aria-label': [showDate(t.date), c.payeeName, unsigned(t.amount, account.currency), current && '(current)'].filter(Boolean).join(' ') } }} />
                        </TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>{showDate(t.date)}</TableCell>
                        <TableCell>
                          {c.payeeName ?? ''}
                          {current && <Typography component="span" variant="caption" color="primary.main" sx={{ ml: 1 }}>{state === 'proposed' ? 'proposed' : state === 'duplicate' ? 'already imported' : 'current'}</Typography>}
                        </TableCell>
                        <TableCell sx={{ color: 'text.secondary' }}>{c.categoryLabel ?? ''}</TableCell>
                        <TableCell align="right" sx={{ typography: 'numeric' }}>{unsigned(t.amount, account.currency)}</TableCell>
                        <TableCell sx={{ color: 'text.secondary' }}>{c.differences.length > 0 ? c.differences.join(' · ') : 'the same'}</TableCell>
                      </TableRow>
                    )
                  })}
                  {data.candidates.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} sx={{ color: 'text.secondary' }}>
                        {query.trim() !== '' ? 'No transaction matches the search.' : whole ? 'No transaction in the account could be this bank line.' : 'No transaction near this date could be this bank line. Search, or show the whole account.'}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
            <FormControlLabel
              control={<Checkbox size="small" checked={whole} onChange={event => setWhole(event.target.checked)} />}
              label="Show transactions from the whole account" />

            {unmatch && <FormControlLabel value={UNMATCH} control={<Radio size="small" />} label={unmatch} />}
            {state !== 'duplicate' && (
              <FormControlLabel value={SKIP} control={<Radio size="small" />}
                label={state === 'new' ? 'Don’t import this bank line (the transaction added for it is deleted)' : 'Don’t import this bank line'} />
            )}
          </RadioGroup>

          {learns && (
            <FormControlLabel
              control={<Checkbox size="small" checked={rememberPayee} onChange={event => setRemember(event.target.checked)} />}
              label={`Remember that “${data.bankName}” is ${candidate!.payeeName}`} />
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close()}>Cancel</Button>
        <Button type="submit" variant="contained" disabled={!choice || unchanged}>Apply</Button>
      </DialogActions>
    </form>
  )
}
