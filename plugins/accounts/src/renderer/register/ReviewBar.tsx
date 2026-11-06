// Above the register while rows need the user (marked for review by a plugin, such as imported transactions), or a
// plugin has something outstanding that isn't a row: what the plugins say, Next (F8) to go through the rows, and the
// plugins' own actions, such as Accept All.
import type { AnnotationAction, RegisterAnnotations } from '@tessera/accounts-api'
import { Alert, Box, Button, Icon, Stack, Tooltip } from '@tessera/ui'

export function ReviewBar({ count, summaries, editable, onNext, onRun }: {
  /** How many rows need reviewing (none, when only something outstanding keeps the bar up). */
  count: number
  summaries: RegisterAnnotations['summaries']
  /** A closed account shows what needs reviewing, but offers no actions. */
  editable: boolean
  onNext(): void
  onRun(action: AnnotationAction): void
}) {
  const actions = editable ? summaries.flatMap(summary => summary.actions) : []
  return (
    // A status, not an alert: it is there whenever the register loads, and must not interrupt
    <Alert severity="info" role="status" data-note="review" sx={{ mx: 2, my: 1, alignItems: 'center' }}
      action={
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          {/* describeChild: the tooltip describes the button, whose name stays its label */}
          {count > 0 && (
            <Tooltip describeChild title="Go to the next transaction to review (F8; Shift+F8 goes back)">
              <Button color="inherit" size="small" endIcon={<Icon name="ChevronRight" />} onClick={onNext}>Next</Button>
            </Tooltip>
          )}
          {actions.map(action => (
            <Tooltip key={action.id} describeChild title={action.tooltip ?? ''}>
              <Button color="inherit" size="small" variant="outlined" onClick={() => onRun(action)}
                {...(action.icon && { startIcon: <Icon name={action.icon} /> })}>{action.label}</Button>
            </Tooltip>
          ))}
        </Stack>
      }>
      {summaries.length > 0
        ? summaries.map(summary => <Box key={summary.contributor}>{summary.message}</Box>)
        : `${count} ${count === 1 ? 'transaction' : 'transactions'} to review`}
    </Alert>
  )
}
