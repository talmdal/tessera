// QIF Options: only the questions a file raises, each with the file's own example read every way it can be: its dates
// (when every day is 12 or less) and its decimal separator (when every amount fits both). The answers are remembered
// for the file's source. See docs/import-formats-design.md, "The QIF Options dialog".
import { FormEvent, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import type { DateOrder, DecimalSeparator } from '@tessera/import-api'
import { Button, DialogActions, DialogContent, FormControl, FormControlLabel, FormLabel, Radio, RadioGroup, Stack, Typography } from '@tessera/ui'
import type { OptionsDialogInput, OptionsDialogResult, QifChoice } from '../shared/options'

function Question<T extends string>({ id, label, choices, value, onChange, autoFocus }: {
  id: string, label: string, choices: QifChoice<T>[], value: T, onChange: (value: T) => void, autoFocus?: boolean
}) {
  return (
    <FormControl>
      <FormLabel id={id}>{label}</FormLabel>
      <RadioGroup aria-labelledby={id} value={value} onChange={event => onChange(event.target.value as T)}>
        {choices.map((choice, i) => (
          <FormControlLabel key={choice.value} value={choice.value} label={choice.label}
            control={<Radio size="small" autoFocus={autoFocus && (choice.value === value || (i === 0 && !choices.some(c => c.value === value)))} />} />
        ))}
      </RadioGroup>
    </FormControl>
  )
}

export default function OptionsDialog({ input, close }: DialogProps<OptionsDialogInput, OptionsDialogResult>) {
  const [dateOrder, setDateOrder] = useState<DateOrder | undefined>(input.dates?.value)
  const [decimal, setDecimal] = useState<DecimalSeparator | undefined>(input.decimal?.value)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    close({ kind: 'options', ...(dateOrder && { dateOrder }), ...(decimal && { decimal }) })
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogContent>
        <Stack spacing={2}>
          <Typography>
            {input.fileName} can be read more than one way. Choose how, and files like it will be read the same way.
          </Typography>
          {input.dates && dateOrder && (
            <Question id="qif-dates" label={`Dates: every day in the file is 12 or less, so “${input.dates.example}” could be either`}
              choices={input.dates.choices} value={dateOrder} onChange={setDateOrder} autoFocus />
          )}
          {input.decimal && decimal && (
            <Question id="qif-decimal" label={`Amounts: “${input.decimal.example}” could be either`}
              choices={input.decimal.choices} value={decimal} onChange={setDecimal} autoFocus={!input.dates} />
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close({ kind: 'skip' })}>Skip This File</Button>
        <Button onClick={() => close()}>Cancel Import</Button>
        <Button type="submit" variant="contained">OK</Button>
      </DialogActions>
    </form>
  )
}
