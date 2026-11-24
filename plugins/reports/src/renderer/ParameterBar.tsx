// The report's heading parameters: *Period* (or *As of*, or the dates of a balance over time), *Accounts* (the whole
// ledger, a sub-ledger of its tree, the everyday accounts in it, or accounts chosen one by one), *Currency*, *Compare
// with*, the members a definition lets the user pick (Category Trends' categories), and the source's own parameters.
// Changing one runs the report again at once; the view owns the values. Periods are named as the run names them, by
// the same pure code (docs/reporting-design.md, "Periods").
import { useEffect, useMemo, useState } from 'react'
import { ACCOUNT_TYPE_LABELS, type AccountType } from '@tessera/accounts-api'
import {
  EVERYDAY_ACCOUNT_TYPES, REPORTS_CHANNELS, addDays, addMonths, addMonthsToDate, daysIn, firstDayOf, isDate, lastDayOf, monthOf, monthsBetween,
  periodLabel, resolveAsOf, resolvePeriod,
  type AsOfValue, type CompareValue, type Member, type OpenedView, type PeriodPreset, type PeriodValue, type ReportParameters, type ReportsResult,
  type ScopeValue
} from '@tessera/reports-api'
import { Autocomplete, Checkbox, FormControlLabel, MenuItem, Stack, TextField, Typography } from '@tessera/ui'
import { showDate } from './display'

export const PRESETS: { value: PeriodPreset, label: string }[] = [
  { value: 'thisMonth', label: 'This month' }, { value: 'lastMonth', label: 'Last month' },
  { value: 'thisQuarter', label: 'This quarter' }, { value: 'lastQuarter', label: 'Last quarter' },
  { value: 'thisYear', label: 'This year' }, { value: 'lastYear', label: 'Last year' }, { value: 'yearToDate', label: 'Year to date' },
  { value: 'last3Months', label: 'Last 3 months' }, { value: 'last12Months', label: 'Last 12 months' }, { value: 'allDates', label: 'All dates' }
]

const AS_OF: { value: 'today' | 'endOfLastMonth' | 'endOfLastYear', label: string }[] = [
  { value: 'today', label: 'Today' }, { value: 'endOfLastMonth', label: 'End of last month' }, { value: 'endOfLastYear', label: 'End of last year' }
]

export const COMPARE_LABELS: Record<string, string> = {
  none: 'Nothing', previousPeriod: 'The period before', previousYear: 'The same period a year before', subLedgers: 'Sub-ledgers side by side',
  asOf: 'Another date…'
}

const GRAIN_ENDS = { month: 'Month ends', quarter: 'Quarter ends', year: 'Year ends' } as const

const sameTypes = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(t => b.includes(t))

/** The period a value names, resolved as the run resolves it; undefined for *All dates*, which only the run can know. */
export function rangeOf(value: PeriodValue, view: Pick<OpenedView, 'today' | 'yearStart'>) {
  if ('preset' in value && value.preset === 'allDates') return undefined
  return resolvePeriod(value, view.today, view.yearStart)
}

/** The period moved back (-1) or on (+1) by its own length: whole months by months, anything else by days. */
export function stepPeriod(value: PeriodValue, direction: 1 | -1, view: Pick<OpenedView, 'today' | 'yearStart'>): PeriodValue | undefined {
  const range = rangeOf(value, view)
  if (!range) return undefined
  const wholeMonths = range.from === firstDayOf(monthOf(range.from)) && range.to === lastDayOf(monthOf(range.to))
  if (wholeMonths) {
    const n = monthsBetween(monthOf(range.from), monthOf(range.to)).length * direction
    return { from: firstDayOf(addMonths(monthOf(range.from), n)), to: lastDayOf(addMonths(monthOf(range.to), n)) }
  }
  const n = daysIn(range) * direction
  return { from: addDays(range.from, n), to: addDays(range.to, n) }
}

/** Page Up and Page Down: the period, or the dates, a step back or on. Undefined when there is nothing to step. */
export function stepParameters(parameters: ReportParameters, direction: 1 | -1, view: Pick<OpenedView, 'today' | 'yearStart' | 'grain' | 'source'>): ReportParameters | undefined {
  if (view.source.time !== 'asOf') {
    const period = parameters.period && stepPeriod(parameters.period, direction, view)
    return period && { ...parameters, period }
  }
  const asOf = parameters.asOf
  if (!asOf) return undefined
  if ('ends' in asOf) {
    const ends = stepPeriod(asOf.ends, direction, view)
    return ends && { ...parameters, asOf: { ends } }
  }
  const [date] = resolveAsOf(asOf, view.grain, view.today, view.yearStart)
  if (!date) return undefined
  // A month end steps to a month end; any other date by a month
  const next = date === lastDayOf(monthOf(date)) ? lastDayOf(addMonths(monthOf(date), direction)) : addMonthsToDate(date, direction)
  return { ...parameters, asOf: { date: next } }
}

/** The sub-ledgers in the tree's order, each with its depth, for the Accounts list. */
function treeOrder(subLedgers: OpenedView['choices']['subLedgers']) {
  const out: { id: string, name: string, depth: number }[] = []
  const walk = (parentId: string | null, depth: number) => {
    for (const s of subLedgers.filter(x => x.parentId === parentId).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))) {
      out.push({ id: s.id, name: s.name, depth })
      walk(s.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

export interface ParameterBarProps {
  view: OpenedView
  parameters: ReportParameters
  /** The currency the last run was in: what *Most used* came to. */
  resolvedCurrency?: string | null
  onChange(next: ReportParameters): void
}

export function ParameterBar({ view, parameters, resolvedCurrency, onChange }: ParameterBarProps) {
  const set = (patch: Partial<ReportParameters>) => onChange({ ...parameters, ...patch })
  const allowed = view.source.scopes === 'none' ? [] : view.source.scopes
  return (
    <Stack direction="row" sx={{ flexWrap: 'wrap', alignItems: 'center', columnGap: 1.5, rowGap: 1, px: 2, py: 1 }} data-parameters>
      {view.source.time === 'asOf'
        ? <AsOfField view={view} value={parameters.asOf ?? { at: 'today' }} onChange={asOf => set({ asOf })} />
        : <PeriodField view={view} label="Period" value={parameters.period ?? { preset: 'thisYear' }} onChange={period => set({ period })} />}
      {allowed.length > 0 && <AccountsField view={view} allowed={allowed} value={parameters.scope ?? { kind: 'ledger' }} onChange={scope => set({ scope })} />}
      {view.source.currency && (
        <TextField
          select size="small" label="Currency" value={parameters.currency ?? 'mostUsed'} sx={{ minWidth: '9em' }}
          onChange={event => set({ currency: event.target.value })}
        >
          <MenuItem value="mostUsed">{`Most used${resolvedCurrency ? ` (${resolvedCurrency})` : ''}`}</MenuItem>
          {view.choices.currencies.map(c => <MenuItem key={c} value={c}>{c}</MenuItem>)}
          {view.source.time === 'asOf' && <MenuItem value="all">Each account’s own</MenuItem>}
        </TextField>
      )}
      {view.compareOptions.length > 0 && <CompareField view={view} value={parameters.compare ?? 'none'} onChange={compare => set({ compare })} />}
      {view.choose.map(c => (
        <MemberPicker
          key={c.dimension} view={view} parameters={parameters} dimension={c.dimension} label={c.label}
          value={parameters.chosen?.[c.dimension] ?? []}
          onChange={ids => set({ chosen: { ...parameters.chosen, [c.dimension]: ids } })}
        />
      ))}
      {view.source.parameters.map(p => (
        <SourceParameterField key={p.key} view={view} parameters={parameters} parameter={p} value={parameters.source?.[p.key]}
          onChange={value => set({ source: { ...parameters.source, [p.key]: value } })} />
      ))}
    </Stack>
  )
}

function PeriodField({ view, label, value, onChange }: { view: OpenedView, label: string, value: PeriodValue, onChange(value: PeriodValue): void }) {
  const preset = 'preset' in value ? value.preset : 'custom'
  const range = rangeOf(value, view)
  return (
    <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
      <TextField
        select size="small" label={label} value={preset} sx={{ minWidth: '10em' }}
        onChange={event => {
          const next = event.target.value
          if (next === 'custom') onChange(range ? { from: range.from, to: range.to } : { from: `${view.today.slice(0, 4)}-01-01`, to: view.today })
          else onChange({ preset: next as PeriodPreset })
        }}
      >
        {PRESETS.map(p => <MenuItem key={p.value} value={p.value}>{p.label}</MenuItem>)}
        <MenuItem value="custom">Custom…</MenuItem>
      </TextField>
      {'preset' in value
        ? range && <Typography variant="body2" color="text.secondary" data-period-label>{periodLabel(range, view.yearStart)}</Typography>
        : <>
            <DateField label="From" value={value.from} onChange={from => onChange({ from, to: value.to < from ? from : value.to })} />
            <DateField label="To" value={value.to} onChange={to => onChange({ from: value.from > to ? to : value.from, to })} />
          </>}
    </Stack>
  )
}

function AsOfField({ view, value, onChange }: { view: OpenedView, value: AsOfValue, onChange(value: AsOfValue): void }) {
  // Dates over a period (Net Worth): the month, quarter or year ends in it
  if ('ends' in value) return <PeriodField view={view} label={GRAIN_ENDS[view.grain]} value={value.ends} onChange={ends => onChange({ ends })} />
  const choice = 'at' in value ? value.at : 'date'
  return (
    <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
      <TextField
        select size="small" label="As of" value={choice} sx={{ minWidth: '10em' }}
        onChange={event => {
          const next = event.target.value
          if (next === 'date') onChange({ date: resolveAsOf(value, view.grain, view.today, view.yearStart)[0] ?? view.today })
          else onChange({ at: next as 'today' | 'endOfLastMonth' | 'endOfLastYear' })
        }}
      >
        {AS_OF.map(a => <MenuItem key={a.value} value={a.value}>{a.label}</MenuItem>)}
        <MenuItem value="date">A date…</MenuItem>
      </TextField>
      {'date' in value
        ? <DateField label="Date" value={value.date} onChange={date => onChange({ date })} />
        : <Typography variant="body2" color="text.secondary" data-period-label>{showDate(resolveAsOf(value, view.grain, view.today, view.yearStart)[0] ?? view.today)}</Typography>}
    </Stack>
  )
}

function DateField({ label, value, onChange }: { label: string, value: string, onChange(value: string): void }) {
  // Kept as typed until it is a whole date, so typing a year digit by digit doesn't run the report each time
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <TextField
      type="date" size="small" label={label} value={text} sx={{ width: '11em' }} slotProps={{ inputLabel: { shrink: true } }}
      onChange={event => { setText(event.target.value); if (isDate(event.target.value)) onChange(event.target.value) }}
    />
  )
}

const CHOSEN = '\u0000chosen'
/** The whole ledger, in the Accounts list: a value of its own, since a select reads '' as nothing chosen. */
const LEDGER = '\u0000ledger'

function AccountsField({ view, allowed, value, onChange }: { view: OpenedView, allowed: readonly string[], value: ScopeValue, onChange(value: ScopeValue): void }) {
  const tree = useMemo(() => treeOrder(view.choices.subLedgers), [view.choices.subLedgers])
  const where = value.kind === 'subLedger' ? value.subLedgerId : value.kind === 'types' ? value.subLedgerId ?? LEDGER : value.kind === 'accounts' ? CHOSEN : LEDGER
  const types = value.kind === 'types' ? value.types : undefined
  const typesLabel = (list: readonly AccountType[]) => sameTypes(list, EVERYDAY_ACCOUNT_TYPES)
    ? 'Everyday accounts only'
    : `Only ${list.map(t => ACCOUNT_TYPE_LABELS[t] ?? t).join(', ')}`
  const rememberedTypes: AccountType[] = types ?? [...EVERYDAY_ACCOUNT_TYPES]
  const place = (id: string, withTypes: readonly AccountType[] | undefined): ScopeValue => {
    if (withTypes && allowed.includes('types')) return { kind: 'types', types: [...withTypes], ...(id !== LEDGER && { subLedgerId: id }) }
    return id === LEDGER ? { kind: 'ledger' } : { kind: 'subLedger', subLedgerId: id }
  }
  const accounts = view.choices.accounts
  return (
    <Stack direction="row" sx={{ alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
      <TextField
        select size="small" label="Accounts" value={where} sx={{ minWidth: '12em' }}
        onChange={event => {
          const next = event.target.value
          if (next === CHOSEN) onChange({ kind: 'accounts', accountIds: accounts.filter(a => !a.closed).slice(0, 1).map(a => a.id) })
          else onChange(place(next, types))
        }}
      >
        <MenuItem value={LEDGER}>{`Whole ledger (${view.choices.ledgerName})`}</MenuItem>
        {allowed.includes('subLedger') || allowed.includes('types')
          ? tree.map(s => <MenuItem key={s.id} value={s.id} sx={{ pl: 2 + s.depth * 2 }}>{s.name}</MenuItem>)
          : null}
        {allowed.includes('accounts') && <MenuItem value={CHOSEN}>Chosen accounts…</MenuItem>}
      </TextField>
      {allowed.includes('types') && value.kind !== 'accounts' && (
        <FormControlLabel
          label={typesLabel(rememberedTypes)}
          control={<Checkbox size="small" checked={types !== undefined} onChange={event => onChange(place(where === CHOSEN ? LEDGER : where, event.target.checked ? rememberedTypes : undefined))} />}
        />
      )}
      {value.kind === 'accounts' && (
        <Autocomplete
          multiple size="small" sx={{ minWidth: '18em' }} options={accounts.map(a => a.id)}
          value={value.accountIds.filter(id => accounts.some(a => a.id === id))}
          getOptionLabel={id => accounts.find(a => a.id === id)?.name ?? id}
          onChange={(_event, ids) => { if (ids.length > 0) onChange({ kind: 'accounts', accountIds: ids }) }}
          renderInput={params => <TextField {...params} label="Chosen accounts" />}
        />
      )}
    </Stack>
  )
}

function CompareField({ view, value, onChange }: { view: OpenedView, value: CompareValue, onChange(value: CompareValue): void }) {
  const choice = typeof value === 'object' ? 'asOf' : value
  const date = typeof value === 'object' ? resolveAsOf(value.asOf, view.grain, view.today, view.yearStart)[0] : undefined
  return (
    <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
      <TextField
        select size="small" label="Compare with" value={choice} sx={{ minWidth: '12em' }}
        onChange={event => {
          const next = event.target.value
          onChange(next === 'asOf' ? { asOf: { at: 'endOfLastYear' } } : next as CompareValue)
        }}
      >
        {['none', ...view.compareOptions].map(o => <MenuItem key={o} value={o}>{COMPARE_LABELS[o] ?? o}</MenuItem>)}
      </TextField>
      {date && <DateField label="Date" value={date} onChange={d => onChange({ asOf: { date: d } })} />}
    </Stack>
  )
}

/** A picker's choices, from the report's source. */
function useMembers(view: OpenedView, parameters: ReportParameters, ask: { dimension?: string, parameter?: string }): Member[] {
  const [members, setMembers] = useState<Member[]>([])
  const scope = JSON.stringify(parameters.scope ?? null)
  useEffect(() => {
    if (ask.dimension === undefined && ask.parameter === undefined) return
    let live = true
    window.api.invoke<ReportsResult<Member[]>>(REPORTS_CHANNELS.members, { ref: view.ref, ...ask, parameters })
      .then(result => { if (live && result.ok) setMembers(result.value) }, () => undefined)
    return () => { live = false }
  }, [view.ref, ask.dimension, ask.parameter, scope])
  return members
}

function MemberPicker({ view, parameters, dimension, label, value, onChange }: {
  view: OpenedView, parameters: ReportParameters, dimension: string, label: string, value: string[], onChange(ids: string[]): void
}) {
  const members = useMembers(view, parameters, { dimension })
  const byId = useMemo(() => new Map(members.map(m => [m.id, m])), [members])
  // A tree's members read with their parents: "Food : Groceries"
  const nameOf = (id: string): string => {
    const m = byId.get(id)
    if (!m) return id
    return m.parentId && byId.has(m.parentId) ? `${nameOf(m.parentId)} : ${m.label}` : m.label
  }
  return (
    <Autocomplete
      multiple size="small" sx={{ minWidth: '16em', maxWidth: '32em' }} options={members.map(m => m.id).sort((a, b) => nameOf(a).localeCompare(nameOf(b)))}
      value={value} getOptionLabel={nameOf} onChange={(_event, ids) => onChange(ids)}
      renderInput={params => <TextField {...params} label={label} placeholder={value.length === 0 ? 'All' : undefined} />}
    />
  )
}

function SourceParameterField({ view, parameters, parameter, value, onChange }: {
  view: OpenedView, parameters: ReportParameters, parameter: OpenedView['source']['parameters'][number], value: string | undefined, onChange(value: string): void
}) {
  const members = useMembers(view, parameters, parameter.kind === 'member' ? { parameter: parameter.key } : {})
  const choices = parameter.kind === 'choice' ? parameter.choices ?? [] : members.map(m => ({ value: m.id, label: m.label }))
  const current = value ?? members.find(m => m.isDefault)?.id ?? choices[0]?.value ?? ''
  return (
    <TextField select size="small" label={parameter.label} value={choices.some(c => c.value === current) ? current : ''} sx={{ minWidth: '10em' }}
      onChange={event => onChange(event.target.value)}>
      {choices.map(c => <MenuItem key={c.value} value={c.value}>{c.label}</MenuItem>)}
    </TextField>
  )
}
