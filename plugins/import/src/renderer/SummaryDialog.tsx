// What an import did, statement by statement: what was added and where, what was matched to transactions already
// there, what was imported before, what was left out and why; and a way to the register, to review them.
import type { DialogProps } from '@tessera/types'
import type { ImportReport, StatementCategories, StatementReport, SummaryDialogResult } from '@tessera/import-api'
import { displayDate } from '@tessera/ledger-api'
import { Alert, Box, Button, DialogActions, DialogContent, Icon, Stack, Typography } from '@tessera/ui'
import { count } from './display'

const MAX_WARNINGS = 5

/** One statement's outcome, as a sentence. */
export function describe(result: StatementReport): string {
  const { counts } = result
  const where = result.accountName ? `“${result.accountName}”` : 'the account'
  switch (result.outcome) {
    case 'imported': {
      const matched = counts.matched + counts.possible
      const possible = counts.possible > 0 ? ` (${counts.possible.toLocaleString()} possible)` : ''
      // Lines dated before the account's last archival date are never added (that period is in an archive file)
      const archived = counts.archived ?? 0
      // Lines that looked like transactions imported before from another file: proposed in the register, not added
      const already = counts.alreadyImported ?? 0
      const archivedPart = `${archived.toLocaleString()} left out as dated before ${result.lastArchiveDate ? displayDate(result.lastArchiveDate) : 'the account’s last archival date'} (the last archival date)`
      if (counts.added === 0 && matched === 0 && already === 0 && archived > 0) {
        const details = [
          ...(counts.duplicates > 0 ? [`${counts.duplicates.toLocaleString()} already imported`] : []),
          archivedPart,
          ...(counts.invalid > 0 ? [`${counts.invalid.toLocaleString()} left out`] : [])
        ]
        return `Nothing new for ${where}: ${details.join(', ')}.`
      }
      const parts = counts.added > 0
        ? [`${count(counts.added, 'transaction')} added to ${where}`]
        : matched > 0
          ? [`${count(matched, 'transaction')} in ${where} matched to ones already there${possible}`]
          : already > 0
            ? [`Nothing added to ${where}`]
            : [counts.duplicates > 0 ? `Nothing new for ${where}: all ${count(counts.duplicates, 'transaction')} were already imported` : `Nothing to add to ${where}`]
      if (counts.added > 0 && matched > 0) parts.push(`${matched.toLocaleString()} matched to ones already there${possible}`)
      if ((counts.added > 0 || matched > 0 || already > 0) && counts.duplicates > 0) parts.push(`${counts.duplicates.toLocaleString()} already imported`)
      if (already > 0) {
        parts.push(`${already.toLocaleString()} looked like ${already === 1 ? 'a transaction' : 'transactions'} imported before from another file and ${already === 1 ? 'wasn’t' : 'weren’t'} added: check ${already === 1 ? 'it' : 'them'} in the register`)
      }
      if (archived > 0) parts.push(archivedPart)
      if (counts.invalid > 0) parts.push(`${counts.invalid.toLocaleString()} left out`)
      // Lines whose bank id had named other transactions before were imported by their content, not dropped
      const conflicts = counts.idConflicts ?? 0
      if (conflicts > 0) parts.push(`${conflicts.toLocaleString()} recognised by ${conflicts === 1 ? 'its' : 'their'} content, as the bank had used ${conflicts === 1 ? 'its id' : 'their ids'} before for other transactions`)
      return `${parts.join(', ')}.`
    }
    case 'skipped': return 'Skipped.'
    case 'cancelled': return result.error?.message ? `Cancelled: ${result.error.message}` : 'Cancelled.'
    case 'needsAccount': return 'Not imported: no account could be found for it.'
    case 'needsConfirmation': return `Not imported: its amounts may be the wrong way round for ${where}, and this import couldn’t ask.`
    case 'failed': return result.error?.message ?? 'Not imported.'
  }
}

/** When a statement's amounts were reversed, in a sentence. */
export function describeReversed(reversed: NonNullable<StatementReport['reversed']>): string {
  if (reversed.decidedBy === 'remembered') return 'Amounts reversed, as you chose for files like this one.'
  return reversed.remembered ? 'Amounts reversed, as you chose; files like this one will be too.' : 'Amounts reversed, this time.'
}

/** What a statement's new lines did with the categories their file gave, in a sentence. */
export function describeCategories(categories: StatementCategories): string {
  const n = count(categories.offered, 'new transaction')
  const source = `“${categories.sourceLabel}”`
  if (categories.source === 'file') {
    return categories.decidedBy === 'asked' && !categories.remembered
      ? `${n} took ${categories.offered === 1 ? 'its category' : 'their categories'} from the file, this time.`
      : `${n} took ${categories.offered === 1 ? 'its category' : 'their categories'} from the file, as you chose for ${source}.`
  }
  if (categories.decidedBy === 'default') return `The file gave categories for ${n}, which weren’t used: this import didn’t ask.`
  return categories.decidedBy === 'asked' && !categories.remembered
    ? `The file gave categories for ${n}, which weren’t used, this time.`
    : `The file gave categories for ${n}, which weren’t used, as you chose for ${source}.`
}

const ICON: Record<StatementReport['outcome'], { name: string, color: 'success' | 'info' | 'warning' | 'error' | 'disabled' }> = {
  imported: { name: 'Check', color: 'success' },
  skipped: { name: 'Info', color: 'disabled' },
  cancelled: { name: 'Info', color: 'disabled' },
  needsAccount: { name: 'Warning', color: 'warning' },
  needsConfirmation: { name: 'Warning', color: 'warning' },
  failed: { name: 'Error', color: 'error' }
}

export default function SummaryDialog({ input, close }: DialogProps<ImportReport, SummaryDialogResult>) {
  const statementsPerSource = new Map<string, number>()
  for (const r of input.results) statementsPerSource.set(r.source, (statementsPerSource.get(r.source) ?? 0) + 1)
  // The first account with transactions to review, to go and see them
  const review = input.results.find(r => r.outcome === 'imported' && r.counts.added + r.counts.matched + r.counts.possible + (r.counts.alreadyImported ?? 0) > 0 && r.accountId)

  return (
    <>
      <DialogContent>
        <Stack spacing={1.5}>
          {(input.notices ?? []).map(notice => <Alert key={notice} severity="info">{notice}</Alert>)}
          <Box component="ul" aria-label="What was imported" sx={{ listStyle: 'none', m: 0, p: 0, display: 'grid', gap: 1.25 }}>
            {input.results.map((result, i) => {
              const icon = ICON[result.outcome]
              const shown = result.warnings.slice(0, MAX_WARNINGS)
              const several = (statementsPerSource.get(result.source) ?? 0) > 1
              return (
                <Box component="li" key={i} data-outcome={result.outcome} sx={{ display: 'flex', alignItems: 'flex-start' }}>
                  <Icon name={icon.name} color={icon.color} fontSize="small" sx={{ mt: 0.25, mr: 1 }} />
                  <Box sx={{ minWidth: 0 }}>
                    <Typography sx={{ fontWeight: 600 }}>{result.source}{several ? `, statement ${result.statementIndex + 1}` : ''}</Typography>
                    <Typography>{describe(result)}</Typography>
                    {result.reversed && <Typography variant="body2" color="text.secondary">{describeReversed(result.reversed)}</Typography>}
                    {result.categories && (
                      <Typography variant="body2" color="text.secondary">
                        {describeCategories(result.categories)}
                        {result.categories.remembered && (
                          <Button size="small" sx={{ ml: 0.5, minWidth: 0, py: 0, verticalAlign: 'baseline' }}
                            aria-label={`Change how files from “${result.categories.sourceLabel}” give categories`}
                            onClick={() => close({ changeCategories: i })}>Change…</Button>
                        )}
                      </Typography>
                    )}
                    {shown.length > 0 && (
                      <Box component="ul" sx={{ m: 0, pl: 2.5, color: 'text.secondary', typography: 'body2' }}>
                        {shown.map((warning, w) => <li key={w}>{warning}</li>)}
                        {result.warnings.length > shown.length && <li>…and {result.warnings.length - shown.length} more.</li>}
                      </Box>
                    )}
                  </Box>
                </Box>
              )
            })}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close({})}>Close</Button>
        {review && <Button variant="contained" autoFocus onClick={() => close({ review: review.accountId })}>Review in Register</Button>}
      </DialogActions>
    </>
  )
}
