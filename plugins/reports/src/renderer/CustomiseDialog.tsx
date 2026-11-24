// Customise Report… (phase R4): the report's own options, drawn from its definition's declaration (a choice as radio
// buttons, a yes-or-no as a checkbox), and under them what every report has: *Show the top* (for rows kept by size)
// and *Open on* (for a report with a chart). Applying shows the report so; nothing is saved (Save Report does that).
// See docs/reporting-design.md, "Customising and saving reports".
import { useState } from 'react'
import type { DialogProps } from '@tessera/types'
import {
  TOP_OPTION, TOP_ROWS_MAX,
  type CustomiseDialogInput, type CustomiseOption, type CustomiseResult, type OptionValues
} from '@tessera/reports-api'
import {
  Box, Button, Checkbox, DialogActions, DialogContent, Divider, FormControl, FormControlLabel, FormHelperText, FormLabel, Radio, RadioGroup,
  Stack, TextField, Typography
} from '@tessera/ui'

const SHOWS: { value: 'both' | 'chart' | 'table', label: string }[] = [
  { value: 'both', label: 'The chart and the table' }, { value: 'chart', label: 'The chart' }, { value: 'table', label: 'The table' }
]

/** A whole number of rows to show, from 1 to the most the page takes, or a reason it isn't one. */
export function topProblem(text: string): string | undefined {
  const value = text.trim()
  if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > TOP_ROWS_MAX) return `Show 1 to ${TOP_ROWS_MAX} rows, or tick Every row.`
  return undefined
}

function OptionField({ option, value, onChange }: { option: CustomiseOption, value: string | boolean, onChange(value: string | boolean): void }) {
  const id = `customise-option-${option.key}`
  if (option.kind === 'boolean') {
    return (
      <Box>
        <FormControlLabel label={option.label} control={<Checkbox size="small" checked={value === true} onChange={event => onChange(event.target.checked)} />} />
        {option.description && <FormHelperText sx={{ mt: -0.5, ml: 4 }}>{option.description}</FormHelperText>}
      </Box>
    )
  }
  return (
    <FormControl component="fieldset">
      <FormLabel id={id} component="legend" sx={{ typography: 'body2', fontWeight: 600 }}>{option.label}</FormLabel>
      <RadioGroup aria-labelledby={id} value={String(value)} onChange={event => onChange(event.target.value)}>
        {(option.choices ?? []).map(c => <FormControlLabel key={c.value} value={c.value} label={c.label} control={<Radio size="small" />} />)}
      </RadioGroup>
      {option.description && <FormHelperText sx={{ mt: 0 }}>{option.description}</FormHelperText>}
    </FormControl>
  )
}

export default function CustomiseDialog({ input, close }: DialogProps<CustomiseDialogInput, CustomiseResult>) {
  const [values, setValues] = useState<OptionValues>(() => Object.fromEntries(input.options.map(o => [o.key, o.value])))
  const top = input.top
  const [every, setEvery] = useState(top?.value === 'all')
  const [rows, setRows] = useState(() => String(top === undefined ? '' : top.value === 'all' ? (top.default === 'all' ? 25 : top.default) : top.value))
  const [show, setShow] = useState(input.show)
  const rowsProblem = top && !every ? topProblem(rows) : undefined

  const reset = () => {
    setValues(Object.fromEntries(input.options.map(o => [o.key, o.default])))
    if (top) { setEvery(top.default === 'all'); setRows(String(top.default === 'all' ? 25 : top.default)) }
  }
  const apply = () => {
    if (rowsProblem) return
    const options: OptionValues = { ...values }
    // Left at its default, *Show the top* isn't kept: a report taking its top from the Reports page keeps following it
    if (top) {
      const chosen: number | 'all' = every ? 'all' : Number(rows.trim())
      if (chosen !== top.default) options[TOP_OPTION] = String(chosen)
    }
    close({ options, ...(show && { show }) })
  }

  return (
    <>
      <DialogContent>
        <Stack sx={{ gap: 2 }} component="form" id="customise-report" onSubmit={event => { event.preventDefault(); apply() }}>
          {input.options.length === 0 && !top && !input.show && (
            <Typography variant="body2" color="text.secondary">This report has nothing to customise.</Typography>
          )}
          {input.options.map(option => (
            <OptionField key={option.key} option={option} value={values[option.key] ?? option.default} onChange={value => setValues(v => ({ ...v, [option.key]: value }))} />
          ))}
          {(top || input.show) && input.options.length > 0 && <Divider />}
          {top && (
            <Box>
              <Stack direction="row" sx={{ alignItems: 'flex-start', gap: 2, flexWrap: 'wrap' }}>
                <TextField
                  size="small" label="Show the top" value={rows} disabled={every} sx={{ width: '10em' }}
                  error={rowsProblem !== undefined} helperText={rowsProblem ?? 'rows, then the rest as Other'}
                  slotProps={{ htmlInput: { inputMode: 'numeric' } }}
                  onChange={event => setRows(event.target.value)}
                />
                <FormControlLabel label="Every row" control={<Checkbox size="small" checked={every} onChange={event => setEvery(event.target.checked)} />} />
              </Stack>
            </Box>
          )}
          {input.show && (
            <FormControl component="fieldset">
              <FormLabel id="customise-open-on" component="legend" sx={{ typography: 'body2', fontWeight: 600 }}>Open on</FormLabel>
              <RadioGroup aria-labelledby="customise-open-on" value={show} onChange={event => setShow(event.target.value as typeof show)}>
                {SHOWS.map(s => <FormControlLabel key={s.value} value={s.value} label={s.label} control={<Radio size="small" />} />)}
              </RadioGroup>
            </FormControl>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={reset} sx={{ mr: 'auto' }}>Restore Defaults</Button>
        <Button onClick={() => close()}>Cancel</Button>
        <Button variant="contained" type="submit" form="customise-report" disabled={rowsProblem !== undefined}>Apply</Button>
      </DialogActions>
    </>
  )
}
