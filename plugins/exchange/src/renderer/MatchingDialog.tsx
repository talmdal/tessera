// Change Transaction Matching, as Money had it: the bank's entry pinned at the top, then two choices —
//
//   ◉ Keep this transaction unmatched.   The bank entry enters the register as a new item.
//   ◯ Match this transaction to an item in my register.   The bank entry is combined with the item you select.
//
// An unmatched row opens with the first selected; a matched row opens with the second, its current match
// ticked. Exactly one item can be ticked, and ticking one while “keep unmatched” is selected switches the
// choice. Done returns the decision; the row itself is accepted later, in the register, with its own Accept.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import type { MatchingCandidate, MatchingDialogInput, MatchingDialogResult } from '@tessera/exchange-api'
import {
  Box, Button, Checkbox, DialogActions, DialogContent, FormControlLabel, Radio, RadioGroup, Stack, Table,
  TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip, Typography
} from '@tessera/ui'
import { Amount, STATUS_WORDS, showDate } from './display'

type Choice = 'unmatched' | 'match'

export default function MatchingDialog({ input, close }: DialogProps<MatchingDialogInput, MatchingDialogResult>) {
  const { entry, currency, candidates } = input
  const [choice, setChoice] = useState<Choice>(input.currentId === undefined ? 'unmatched' : 'match')
  const [ticked, setTicked] = useState<string | undefined>(input.currentId)
  const list = useRef<HTMLDivElement>(null)

  const lines = useMemo(() =>
    [...candidates].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)), [candidates])

  // Open at the current match, else at the candidate nearest the bank entry's date
  useEffect(() => {
    const target = input.currentId ?? nearest(lines, entry.date)?.id
    if (target === undefined) return
    const element = list.current?.querySelector(`[data-line="${target}"]`) as HTMLElement | null
    element?.scrollIntoView?.({ block: 'center' })
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  /** Exactly one item: ticking one unticks any other; ticking also selects the match choice. */
  const toggle = (id: string) => {
    setTicked(was => (was === id ? undefined : id))
    setChoice('match')
  }

  const done = () => close(choice === 'unmatched' || ticked === undefined
    ? { matchTo: null }
    : { matchTo: ticked })

  return (
    <>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, minHeight: 420 }}>
        <Box data-matching="bank-entry" sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1 }}>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'baseline' }}>
            <Typography variant="body2" color="text.secondary" sx={{ minWidth: 80 }}>Bank Entry:</Typography>
            <Typography variant="body2" sx={{ minWidth: 96 }}>{showDate(entry.date)}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ minWidth: 48 }}>{entry.number ?? ''}</Typography>
            <Typography variant="body2" sx={{ flex: 1 }} noWrap title={entry.memo}>
              {entry.payee ?? entry.memo ?? 'Transaction'}
            </Typography>
            <Typography variant="body2"><Amount minor={entry.amount} currency={currency} /></Typography>
          </Stack>
        </Box>

        <RadioGroup value={choice} onChange={event => setChoice(event.target.value as Choice)} aria-label="Matching">
          <FormControlLabel
            value="unmatched"
            control={<Radio size="small" />}
            label={
              <Box>
                <Typography variant="body2">Keep this transaction unmatched.</Typography>
                <Typography variant="caption" color="text.secondary">
                  The bank transaction enters your register as a new item.
                </Typography>
              </Box>
            }
          />
          <FormControlLabel
            value="match"
            disabled={lines.length === 0}
            control={<Radio size="small" />}
            label={
              <Box>
                <Typography variant="body2">Match this transaction to an item in my register.</Typography>
                <Typography variant="caption" color="text.secondary">
                  The bank transaction is combined with the item you select.
                </Typography>
              </Box>
            }
          />
        </RadioGroup>

        {lines.length === 0
          ? (
            <Typography variant="body2" color="text.secondary">
              Nothing in the register could be this transaction.
            </Typography>
          )
          : (
            <TableContainer ref={list}
              sx={{ flex: 1, minHeight: 200, maxHeight: 360, border: 1, borderColor: 'divider', borderRadius: 1, opacity: choice === 'match' ? 1 : 0.6 }}>
              <Table size="small" stickyHeader sx={{ '& td, & th': { px: 1, py: 0.25 } }}>
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox" />
                    <TableCell>Num</TableCell>
                    <TableCell>Date</TableCell>
                    <TableCell>Payee</TableCell>
                    <TableCell>Category</TableCell>
                    <TableCell align="right">Amount</TableCell>
                    <TableCell>Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {lines.map(line => {
                    const checked = ticked === line.id
                    const current = line.id === input.currentId
                    const label = `${showDate(line.date)} ${line.payee ?? ''} ${line.amount}`
                    const row = (
                      <TableRow key={line.id} hover selected={checked} data-line={line.id}
                        data-current={current || undefined}
                        onClick={() => toggle(line.id)} sx={{ cursor: 'pointer' }}>
                        <TableCell padding="checkbox">
                          <Checkbox size="small" checked={checked}
                            onClick={event => event.stopPropagation()}
                            onChange={() => toggle(line.id)}
                            slotProps={{ input: { 'aria-label': `Match to ${label}` } }} />
                        </TableCell>
                        <TableCell>{line.number ?? ''}</TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>{showDate(line.date)}</TableCell>
                        <TableCell>
                          <Typography variant="body2" noWrap component="div">
                            {line.payee ?? '(no payee)'}
                            {current && <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>current match</Typography>}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" noWrap component="div" color={line.categoryLabel ? undefined : 'text.secondary'}>
                            {line.categoryLabel ?? ''}
                          </Typography>
                        </TableCell>
                        <TableCell align="right"><Amount minor={line.amount} currency={currency} /></TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>{STATUS_WORDS[line.status]}</TableCell>
                      </TableRow>
                    )
                    return line.caution === 'reconciled'
                      ? <Tooltip key={line.id} title="This item is reconciled; matching it changes a reconciled transaction">{row}</Tooltip>
                      : row
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}

        <Typography variant="body2" color="text.secondary" data-matching="outcome">
          {choice === 'unmatched' || ticked === undefined
            ? 'The bank entry stays unmatched: accepting it enters it as a new item in your register.'
            : 'Once accepted, the bank entry is taken as correct: the item you selected takes its date, amount and payee.'}
        </Typography>
      </DialogContent>

      <DialogActions>
        <Button variant="contained" onClick={done} data-matching-done
          disabled={choice === 'match' && ticked === undefined}>
          Done
        </Button>
        <Button onClick={() => close()}>Cancel</Button>
      </DialogActions>
    </>
  )
}

/** The candidate dated closest to `date`, to open the list there. */
function nearest(lines: readonly MatchingCandidate[], date: string): MatchingCandidate | undefined {
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`)
  let best: MatchingCandidate | undefined
  for (const line of lines) {
    if (best === undefined || Math.abs(day(line.date) - day(date)) < Math.abs(day(best.date) - day(date))) best = line
  }
  return best
}
