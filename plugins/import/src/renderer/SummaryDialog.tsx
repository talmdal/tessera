// What an import did, statement by statement: what was added and where, what was matched to transactions already
// there, what was imported before, what was left out and why; and a way to the register, to review them.
import type { DialogProps } from '@tessera/types'
import type { ImportReport, StatementReport, SummaryDialogResult } from '@tessera/import-api'
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
      const archivedPart = `${archived.toLocaleString()} left out as dated before ${result.lastArchiveDate ? displayDate(result.lastArchiveDate) : 'the account’s last archival date'} (the last archival date)`
      if (counts.added === 0 && matched === 0 && archived > 0) {
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
          : [counts.duplicates > 0 ? `Nothing new for ${where}: all ${count(counts.duplicates, 'transaction')} were already imported` : `Nothing to add to ${where}`]
      if (counts.added > 0 && matched > 0) parts.push(`${matched.toLocaleString()} matched to ones already there${possible}`)
      if ((counts.added > 0 || matched > 0) && counts.duplicates > 0) parts.push(`${counts.duplicates.toLocaleString()} already imported`)
      if (archived > 0) parts.push(archivedPart)
      if (counts.invalid > 0) parts.push(`${counts.invalid.toLocaleString()} left out`)
      return `${parts.join(', ')}.`
    }
    case 'skipped': return 'Skipped.'
    case 'cancelled': return result.error?.message ? `Cancelled: ${result.error.message}` : 'Cancelled.'
    case 'needsAccount': return 'Not imported: no account could be found for it.'
    case 'failed': return result.error?.message ?? 'Not imported.'
  }
}

const ICON: Record<StatementReport['outcome'], { name: string, color: 'success' | 'info' | 'warning' | 'error' | 'disabled' }> = {
  imported: { name: 'Check', color: 'success' },
  skipped: { name: 'Info', color: 'disabled' },
  cancelled: { name: 'Info', color: 'disabled' },
  needsAccount: { name: 'Warning', color: 'warning' },
  failed: { name: 'Error', color: 'error' }
}

export default function SummaryDialog({ input, close }: DialogProps<ImportReport, SummaryDialogResult>) {
  const statementsPerSource = new Map<string, number>()
  for (const r of input.results) statementsPerSource.set(r.source, (statementsPerSource.get(r.source) ?? 0) + 1)
  // The first account with transactions to review, to go and see them
  const review = input.results.find(r => r.outcome === 'imported' && r.counts.added + r.counts.matched + r.counts.possible > 0 && r.accountId)

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
