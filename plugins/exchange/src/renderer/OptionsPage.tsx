// Tools ▸ Options ▸ Import and export.
//
// Deliberately small. Every setting here changes how a file is **read** — what a file is written as belongs to
// the export dialog, where the choice is per-export and the user is looking at the thing they are exporting.
// Two more are missing on purpose, and the design note says why: whether an accepted row becomes `E` (that is
// what accepting means) and whether rows start accepted (they do not).
import { useEffect, useState } from 'react'
import type { OptionsPageProps } from '@tessera/types'
import { validateExchangeOptions, type ExchangeOptions } from '@tessera/exchange-api'
import {
  Checkbox, Divider, FormControlLabel, MenuItem, Stack, TextField, Typography
} from '@tessera/ui'

/** One switch, with the sentence that says what turning it off costs. */
function Switch({ label, detail, checked, disabled, onChange }: {
  label: string, detail: string, checked: boolean, disabled: boolean, onChange(next: boolean): void
}) {
  return (
    <FormControlLabel
      control={<Checkbox size="small" checked={checked} disabled={disabled}
        onChange={event => onChange(event.target.checked)} />}
      label={
        <Stack>
          <Typography variant="body2">{label}</Typography>
          <Typography variant="caption" color="text.secondary">{detail}</Typography>
        </Stack>
      }
      sx={{ alignItems: 'flex-start', mr: 0 }} />
  )
}

export default function OptionsPage({ value, onChange, onValidityChange, disabled }: OptionsPageProps<ExchangeOptions>) {
  /** Every edit revalidates: `validate` in the main process is authoritative, this only gates the buttons. */
  const update = (next: ExchangeOptions) => {
    onChange(next)
    onValidityChange(validateExchangeOptions(next).length === 0)
  }
  const setImport = (patch: Partial<ExchangeOptions['import']>) =>
    update({ ...value, import: { ...value.import, ...patch } })


  return (
    <Stack sx={{ gap: 2.5, maxWidth: 560 }} data-options-page="exchange.importExport">
      <Stack sx={{ gap: 1 }}>
        <Typography variant="subtitle2">Matching</Typography>
        <WholeNumberField label="Days either side for a match" value={value.import.dateWindow} disabled={disabled}
          onChange={dateWindow => setImport({ dateWindow })}
          helperText="Banks post a card purchase days after it happened. 0 matches the same day only." />

        <Switch
          label="Match a downloaded row to one you typed yourself"
          detail="Without this, a transaction you entered and the bank's own copy both stay in the register."
          checked={value.import.mergeManualEntries} disabled={disabled}
          onChange={mergeManualEntries => setImport({ mergeManualEntries })} />

        <Switch
          label="Take the bank's memo and cheque number when matching"
          detail="Off by default: what you typed is usually what you meant."
          checked={value.import.adoptBankDetail} disabled={disabled}
          onChange={adoptBankDetail => setImport({ adoptBankDetail })} />
      </Stack>

      <Divider />

      <Stack sx={{ gap: 1 }}>
        <Typography variant="subtitle2">Payees and categories</Typography>
        <Switch
          label="Apply payee rules"
          detail="Turns the bank's text into the name you use — before matching, so a renamed payee finds the transaction you already have."
          checked={value.import.applyRules} disabled={disabled}
          onChange={applyRules => setImport({ applyRules })} />

        <Switch
          label="Offer to remember a payee you rename"
          detail="Shows “Always rename this payee” when you edit a statement line."
          checked={value.import.learnRules} disabled={disabled}
          onChange={learnRules => setImport({ learnRules })} />

        <Switch
          label="Create categories a file defines"
          detail="Only QIF files carry a category list; OFX and most CSV exports carry none."
          checked={value.import.createCategories} disabled={disabled}
          onChange={createCategories => setImport({ createCategories })} />
      </Stack>

      <Divider />

      <Stack sx={{ gap: 1 }}>
        <Typography variant="subtitle2">Files</Typography>
        <TextField
          size="small" select label="How QIF dates are read" sx={{ maxWidth: 320 }}
          value={value.qif.dateOrder} disabled={disabled}
          onChange={event => update({
            ...value, qif: { ...value.qif, dateOrder: event.target.value as ExchangeOptions['qif']['dateOrder'] }
          })}
          helperText="QIF writes 5/3 for both 5 March and 3 May."
          slotProps={{ htmlInput: { 'aria-label': 'How QIF dates are read' } }}>
          <MenuItem value="auto">Work it out, and ask if it cannot</MenuItem>
          <MenuItem value="dmy">Day first (5/3 is 5 March)</MenuItem>
          <MenuItem value="mdy">Month first (5/3 is 3 May)</MenuItem>
        </TextField>

        <WholeNumberField label="Refuse a file with more rows than" value={value.import.maxRows} disabled={disabled}
          onChange={maxRows => setImport({ maxRows })}
          helperText="A guard against opening something that is not a statement." />

        <TextField
          size="small" label="Start the open dialog in" sx={{ maxWidth: 420 }}
          value={value.import.defaultFolder} disabled={disabled}
          onChange={event => setImport({ defaultFolder: event.target.value })}
          helperText="Leave empty for your Documents folder."
          slotProps={{ htmlInput: { 'aria-label': 'Start the open dialog in' } }} />
      </Stack>

      <Divider />

      <Stack sx={{ gap: 1 }}>
        <Typography variant="subtitle2">History</Typography>
        <WholeNumberField label="Imports to keep in the history" value={value.history.keep} disabled={disabled}
          onChange={keep => update({ ...value, history: { keep } })}
          helperText="Older ones are removed, and can no longer be undone." />
      </Stack>
    </Stack>
  )
}

/** A whole number as typed, or NaN for anything else — which the options' own validation turns into a message. */
const wholeNumber = (text: string) => /^\s*\d+\s*$/.test(text) ? Number(text) : NaN

/**
 * A box for a whole number that shows exactly what was typed. Showing the parsed value instead broke two ways:
 * an empty box became the text "NaN" that could not be typed past, and `1.5` showed `1` after the point and then
 * `15` — a valid value that Apply would have saved without a word. What is typed is kept here; only a whole
 * number goes up, and anything else goes up as NaN so the page is invalid until it is fixed.
 */
function WholeNumberField({ label, value, disabled, helperText, onChange }: {
  label: string, value: number, disabled: boolean, helperText: string, onChange(next: number): void
}) {
  const [text, setText] = useState(() => Number.isFinite(value) ? String(value) : '')
  // A change from outside — Restore Defaults, say — replaces what is typed; the page's own edits never do.
  useEffect(() => {
    if (Number.isFinite(value) && wholeNumber(text) !== value) setText(String(value))
  }, [value])   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <TextField
      size="small" label={label} sx={{ maxWidth: 260 }}
      value={text} disabled={disabled} helperText={helperText}
      error={text.trim() !== '' && Number.isNaN(wholeNumber(text))}
      onChange={event => { setText(event.target.value); onChange(wholeNumber(event.target.value)) }}
      slotProps={{ htmlInput: { inputMode: 'numeric', 'aria-label': label } }} />
  )
}
