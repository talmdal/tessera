// Fill from History: a line for each category, and each account transferred with across the budget's scope, from what
// the months before the lines start added up to: the average, rounded up for spending and down for income, or a yearly
// line for what was seen once. Nothing is saved until Fill, which adds every line ticked, or gives a line it has a plan
// from the month chosen, all or none. See docs/budget-design.md, "Filling a budget from history".
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import { amountToInput, minorDigits, parseAmount } from '@tessera/accounts-api'
import {
  BUDGET_AMOUNT_MAX, BUDGET_CHANNELS, FREQUENCIES, FREQUENCY_LABELS, ROUND_TO_CHOICES, STATUS_MONTHS_MAX, addMonths, isMonth, planProblem,
  type BudgetLine, type BudgetResult, type FillRequest, type Frequency, type HistoryDialogInput, type LineInput, type LinePlan,
  type LineSuggestion, type LineTarget, type SuggestRequest
} from '@tessera/budget-api'
import {
  Alert, Button, Checkbox, CircularProgress, DialogActions, DialogContent, MenuItem, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, Typography
} from '@tessera/ui'
import { amount as shown, monthName, monthOnly, rangeName } from './display'
import { needsDay } from './lineForm'

/** A suggestion as the list holds it: ticked or not, and what the user changed, as typed. */
export interface HistoryRow {
  suggestion: LineSuggestion
  ticked: boolean
  amount: string
  frequency: Frequency
  /** 'YYYY-MM-DD', or empty for no particular day. */
  date: string
}

export const targetKey = (t: LineTarget) => t.kind === 'category' ? `c:${t.categoryId}` : `t:${t.accountId}:${t.direction}`

/** What the user changed in a row: kept by what the row is for, so it outlives the suggestions being asked for again. */
export type RowEdits = ReadonlyMap<string, Partial<Pick<HistoryRow, 'ticked' | 'amount' | 'frequency' | 'date'>>>

/**
 * The list's rows: each suggestion as suggested (ticked unless the budget has a line for it), with what the user changed
 * in it. Asking again for other months, another step or another start keeps those changes; what the user didn't touch
 * follows the new suggestion.
 */
export function rowsOf(suggestions: readonly LineSuggestion[], currency: string, edits: RowEdits = new Map()): HistoryRow[] {
  return suggestions.map(suggestion => ({
    suggestion, ticked: suggestion.existingLineId === undefined, amount: amountToInput(suggestion.amount, currency),
    frequency: suggestion.frequency, date: '',
    ...edits.get(targetKey(suggestion.target))
  }))
}

/**
 * A row as the line it would fill, from `start`, or what is wrong with it. With no date it has no particular day: in
 * the month the suggestion says (the month a yearly bill was seen), or `start` once the frequency is changed.
 */
export function lineOf(row: HistoryRow, start: string, currency: string): { line?: LineInput, problem?: string } {
  const parsed = parseAmount(row.amount, currency)
  if (!parsed.ok) return { problem: parsed.message }
  if (parsed.value < 0) return { problem: 'Enter an amount of zero or more.' }
  if (parsed.value > BUDGET_AMOUNT_MAX) return { problem: 'That amount is too large for a budget.' }
  if (row.date === '' && needsDay(row.frequency)) return { problem: 'A weekly or fortnightly plan needs the date it is first due.' }
  const due = row.date !== '' ? row.date : row.frequency === row.suggestion.frequency ? row.suggestion.due : start
  const plan: LinePlan = { from: start, amount: parsed.value, frequency: row.frequency, due }
  const problem = planProblem(plan)
  if (problem) return { problem: problem.message }
  return { line: { target: row.suggestion.target, plan } }
}

export default function HistoryDialog({ input, close, setBusy }: DialogProps<HistoryDialogInput, { count: number }>) {
  const { budget } = input
  const currency = budget.currency
  const [monthsText, setMonthsText] = useState(String(input.months))
  const [roundTo, setRoundTo] = useState(input.roundTo)
  const [start, setStart] = useState(input.start)
  const [suggestions, setSuggestions] = useState<LineSuggestion[]>()
  const [edits, setEdits] = useState<RowEdits>(new Map())
  const rows = useMemo(() => suggestions && rowsOf(suggestions, currency, edits), [suggestions, currency, edits])
  const [loadProblem, setLoadProblem] = useState<string>()
  const [saveProblem, setSaveProblem] = useState<{ message: string, row?: number }>()
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)

  const months = Number(monthsText)
  const monthsValid = Number.isInteger(months) && months >= 1 && months <= STATUS_MONTHS_MAX
  const step = roundTo * 10 ** minorDigits(currency)

  // The suggestions, again whenever what they are based on changes; a late reply to an earlier request is dropped
  const latest = useRef(0)
  useEffect(() => {
    if (!monthsValid || !isMonth(start)) return
    const request = ++latest.current
    setSuggestions(undefined)
    setLoadProblem(undefined)
    const ask: SuggestRequest = { budgetId: budget.id, months, start, step }
    window.api.invoke<BudgetResult<LineSuggestion[]>>(BUDGET_CHANNELS.suggest, ask).then(result => {
      if (request !== latest.current) return
      if (result.ok) setSuggestions(result.value); else setLoadProblem(result.error.message)
    }, err => { if (request === latest.current) setLoadProblem(String(err?.message ?? err)) })
  }, [budget.id, months, monthsValid, start, step])

  const checked = useMemo(() => rows?.map(row => row.ticked ? lineOf(row, start, currency) : {}) ?? [], [rows, start, currency])
  const ticked = rows?.filter(r => r.ticked).length ?? 0
  const set = (index: number, patch: Partial<HistoryRow>) => {
    const row = rows?.[index]
    if (!row) return
    const key = targetKey(row.suggestion.target)
    setEdits(current => new Map(current).set(key, { ...current.get(key), ...patch }))
    setSaveProblem(undefined)
  }
  const tickAll = (value: boolean) => setEdits(current => {
    const next = new Map(current)
    for (const row of rows ?? []) next.set(targetKey(row.suggestion.target), { ...next.get(targetKey(row.suggestion.target)), ticked: value })
    return next
  })

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitted(true)
    if (!rows || ticked === 0 || saving || checked.some(c => c.problem)) return
    const lines = checked.flatMap(c => c.line ? [c.line] : [])
    // The rows ticked, in the order sent: a problem the service names (lines[3].due) is shown on its row
    const sent = rows.flatMap((row, i) => row.ticked ? [i] : [])
    setSaving(true)
    setBusy(true)
    try {
      const request: FillRequest = { budgetId: budget.id, lines }
      const result = await window.api.invoke<BudgetResult<BudgetLine[]>>(BUDGET_CHANNELS.fill, request)
      if (result.ok) { close({ count: result.value.length }); return }
      const at = /^lines\[(\d+)\]/.exec(result.error.field ?? '')
      setSaveProblem({ message: result.error.message, ...(at && { row: sent[Number(at[1])] }) })
    } catch (err) {
      setSaveProblem({ message: String((err as Error)?.message ?? err) })
    } finally {
      setSaving(false)
      setBusy(false)
    }
  }

  /** A row's problem: the service's, once it named the row; else what is wrong with it, once the user saved or changed it. */
  const problemOf = (i: number) => {
    if (saveProblem?.row === i) return saveProblem.message
    const row = rows?.[i]
    const touched = row !== undefined && (row.amount !== amountToInput(row.suggestion.amount, currency) || row.frequency !== row.suggestion.frequency || row.date !== '')
    return submitted || touched ? checked[i]?.problem : undefined
  }

  const history = monthsValid && isMonth(start) ? rangeName({ from: addMonths(start, -months), to: addMonths(start, -1) }) : undefined
  return (
    <form onSubmit={submit} noValidate>
      <DialogContent>
        <Stack spacing={1.5} sx={{ pt: 0.5 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
            <Typography variant="body2">Based on the last</Typography>
            <TextField size="small" margin="none" value={monthsText} onChange={event => setMonthsText(event.target.value)}
              error={!monthsValid} slotProps={{ htmlInput: { 'aria-label': 'Months', inputMode: 'numeric', maxLength: 2, style: { textAlign: 'right' } } }}
              sx={{ width: '4.5em' }} />
            <Typography variant="body2" data-history-range>
              whole months{history ? `: ${history}` : ''}{monthsValid ? '' : ` (1 to ${STATUS_MONTHS_MAX})`}
            </Typography>
          </Stack>
          <Stack direction="row" spacing={1.5}>
            <TextField select size="small" margin="none" label="Round to" value={roundTo} onChange={event => setRoundTo(Number(event.target.value))} sx={{ minWidth: '9em' }}>
              {ROUND_TO_CHOICES.map(choice => <MenuItem key={choice} value={choice}>{shown(choice * 10 ** minorDigits(currency), currency)}</MenuItem>)}
            </TextField>
            <TextField size="small" margin="none" type="month" label="Lines start" value={start} onChange={event => { if (isMonth(event.target.value)) setStart(event.target.value) }}
              slotProps={{ inputLabel: { shrink: true } }} sx={{ width: '12em' }} />
          </Stack>

          {loadProblem && <Alert severity="error">{loadProblem}</Alert>}
          {!rows && !loadProblem && monthsValid && <Stack sx={{ p: 2, alignItems: 'center' }}><CircularProgress size={20} aria-label="Looking at the history" /></Stack>}
          {rows && rows.length === 0 && (
            <Typography color="text.secondary">Nothing in those months to suggest a line from: no income or spending by category, and no transfers across the budget.</Typography>
          )}
          {rows && rows.length > 0 && (
            <TableContainer sx={{ maxHeight: '55vh' }}>
              <Table size="small" stickyHeader aria-label="Suggested lines">
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox">
                      <Checkbox size="small" checked={ticked === rows.length} indeterminate={ticked > 0 && ticked < rows.length}
                        onChange={event => tickAll(event.target.checked)} slotProps={{ input: { 'aria-label': 'Tick every line' } }} />
                    </TableCell>
                    <TableCell>For</TableCell>
                    <TableCell align="right">Average a month</TableCell>
                    <TableCell align="right">Suggested</TableCell>
                    <TableCell>How often</TableCell>
                    <TableCell>Due</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((row, i) => (
                    <SuggestionRow key={targetKey(row.suggestion.target)} row={row} index={i} currency={currency} start={start}
                      problem={problemOf(i)}
                      set={set} />
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
          {saveProblem && saveProblem.row === undefined && <Alert severity="error">{saveProblem.message}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close()} disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" disabled={saving || !rows || ticked === 0}>
          {ticked === 1 ? 'Fill 1 Line' : `Fill ${ticked} Lines`}
        </Button>
      </DialogActions>
    </form>
  )
}

function SuggestionRow({ row, index, currency, start, problem, set }: {
  row: HistoryRow, index: number, currency: string, start: string, problem: string | undefined, set(index: number, patch: Partial<HistoryRow>): void
}) {
  const s = row.suggestion
  const once = s.frequency === 'yearly'
  const existing = s.existingPlan
  const label = s.target.kind === 'transfer' ? `${s.target.direction === 'in' ? 'Transfers from' : 'Transfers to'} ${s.label}` : s.label
  return (
    <TableRow data-suggestion={targetKey(s.target)} data-group={s.group} selected={row.ticked}>
      <TableCell padding="checkbox">
        <Checkbox size="small" checked={row.ticked} onChange={event => set(index, { ticked: event.target.checked })} slotProps={{ input: { 'aria-label': label } }} />
      </TableCell>
      <TableCell>
        {label}
        {s.existingLineId !== undefined && (
          <Typography variant="caption" color="text.secondary" component="div" data-existing>
            {existing ? `Has a line: ${shown(existing.amount, currency)} ${FREQUENCY_LABELS[existing.frequency].toLowerCase()}` : 'Has a line, planned from later'}
            {row.ticked ? `; this plans it from ${monthName(start)}` : ''}
          </Typography>
        )}
        {problem && <Typography variant="caption" color="error" component="div" role="alert">{problem}</Typography>}
      </TableCell>
      <TableCell align="right" sx={{ typography: 'numeric', whiteSpace: 'nowrap' }}>
        {once ? `once, ${monthName(s.due)}` : shown(s.average, currency)}
      </TableCell>
      <TableCell align="right" sx={{ py: 0.25 }}>
        <TextField size="small" margin="none" value={row.amount} error={problem !== undefined} disabled={!row.ticked}
          onChange={event => set(index, { amount: event.target.value })}
          slotProps={{ htmlInput: { 'aria-label': `Amount for ${label}`, inputMode: 'decimal', style: { textAlign: 'right' } } }} sx={{ width: '8.5em' }} />
      </TableCell>
      <TableCell sx={{ py: 0.25 }}>
        <TextField select size="small" margin="none" value={row.frequency} disabled={!row.ticked} onChange={event => set(index, { frequency: event.target.value as Frequency })}
          slotProps={{ htmlInput: { 'aria-label': `How often for ${label}` } }} sx={{ minWidth: '11em' }}>
          {FREQUENCIES.map(f => <MenuItem key={f} value={f}>{FREQUENCY_LABELS[f]}</MenuItem>)}
        </TextField>
        {row.frequency === 'yearly' && row.date === '' && (
          <Typography variant="caption" color="text.secondary" component="div">
            in {monthOnly(row.frequency === s.frequency ? s.due : start)}
          </Typography>
        )}
      </TableCell>
      <TableCell sx={{ py: 0.25 }}>
        <TextField size="small" margin="none" type="date" value={row.date} disabled={!row.ticked} onChange={event => set(index, { date: event.target.value })}
          slotProps={{ htmlInput: { 'aria-label': `Due date for ${label}` } }} sx={{ width: '11.5em' }}
          helperText={row.date === '' && !needsDay(row.frequency) ? 'No particular day' : undefined} />
      </TableCell>
    </TableRow>
  )
}
