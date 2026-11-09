// shell/renderer/settings/FieldsPage.tsx — the form the shell draws for a settings page contributed as `fields`.
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FolderSettingsField, JsonObject, NumberSettingsField, SettingsField, SettingsPageProps } from '@tessera/types'
import {
  Box, Button, Checkbox, FormControl, FormControlLabel, FormHelperText, FormLabel, InputAdornment, Radio, RadioGroup, Stack, TextField, Typography
} from '@tessera/ui'
import type { SettingsChooseFolder } from '../../../shared/settings/types'
import { fieldValueProblem } from '../../../shared/settings/fields'
import { getAtPath, setAtPath } from '../../../shared/settings/values'

/** A number as typed: blank, or anything `Number` can't read as a finite number, is not one. */
function parseNumber(text: string): number | undefined {
  if (text.trim() === '') return undefined
  const n = Number(text.trim())
  return Number.isFinite(n) ? n : undefined
}

/**
 * One control per field, bound to the namespace's draft by the field's key. A problem shows under its field and
 * makes the page invalid, which disables OK and Apply; the main process checks the same rules again on saving.
 */
export function FieldsPage({ fields, value, onChange, onValidityChange, disabled, chooseFolder }: SettingsPageProps & {
  fields: readonly SettingsField[]
  /** The platform's folder dialog, for a `folder` field's Browse…. */
  chooseFolder?(request: SettingsChooseFolder): Promise<string | undefined>
}) {
  // What is typed into number fields, by key, while it isn't simply the value (half-typed, or not a number yet).
  const [typed, setTyped] = useState<Record<string, string>>({})

  // A value changed from outside (Restore Defaults, another window) replaces what was typed for it.
  const previous = useRef(value)
  useEffect(() => {
    const before = previous.current
    previous.current = value
    setTyped(current => {
      const stale = Object.keys(current).filter(key => getAtPath(before, key) !== getAtPath(value, key) && parseNumber(current[key]) !== getAtPath(value, key))
      if (stale.length === 0) return current
      const next = { ...current }
      for (const key of stale) delete next[key]
      return next
    })
  }, [value])

  const problems = useMemo(() => Object.fromEntries(fields.map(field => {
    const text = typed[field.key]
    if (field.kind === 'number' && text !== undefined && parseNumber(text) === undefined) return [field.key, `${field.label}: enter a number.`]
    return [field.key, fieldValueProblem(field, getAtPath(value, field.key))]
  })) as Record<string, string | undefined>, [fields, typed, value])

  const valid = Object.values(problems).every(problem => problem === undefined)
  useEffect(() => { onValidityChange(valid) }, [valid, onValidityChange])

  const set = (key: string, item: boolean | number | string) => onChange(setAtPath(value as JsonObject, key, item))

  return (
    <Stack spacing={2.5} sx={{ maxWidth: 520 }}>
      {fields.map(field => (
        <Field key={field.key} field={field} value={getAtPath(value, field.key)} problem={problems[field.key]} disabled={disabled}
          typed={typed[field.key]}
          onType={text => {
            setTyped(current => ({ ...current, [field.key]: text }))
            const n = parseNumber(text)
            if (n !== undefined) set(field.key, n)
          }}
          onSet={item => set(field.key, item)} chooseFolder={chooseFolder} />
      ))}
    </Stack>
  )
}

function Field({ field, value, problem, disabled, typed, onType, onSet, chooseFolder }: {
  field: SettingsField
  value: unknown
  problem?: string
  disabled: boolean
  typed?: string
  onType(text: string): void
  onSet(value: boolean | number | string): void
  chooseFolder?(request: SettingsChooseFolder): Promise<string | undefined>
}) {
  const id = useId()
  // The problem replaces the help while there is one; both are announced with the control.
  const help = problem ?? field.description

  switch (field.kind) {
    case 'boolean':
      return (
        <FormControl error={problem !== undefined}>
          <FormControlLabel
            label={field.label}
            control={<Checkbox checked={value === true} disabled={disabled} onChange={event => onSet(event.target.checked)}
              slotProps={{ input: { 'aria-describedby': help ? `${id}-help` : undefined } }} />} />
          {help && <FormHelperText id={`${id}-help`} sx={{ mt: -0.5, ml: 4 }}>{help}</FormHelperText>}
        </FormControl>
      )

    case 'number':
      return <NumberField field={field} value={value} problem={problem} help={help} disabled={disabled} typed={typed} onType={onType} />

    case 'text':
      return (
        <TextField size="small" fullWidth label={field.label} value={typeof value === 'string' ? value : ''} disabled={disabled}
          placeholder={field.placeholder} required={field.required} error={problem !== undefined} helperText={help}
          onChange={event => onSet(event.target.value)}
          slotProps={{ htmlInput: { ...(field.maxLength !== undefined && { maxLength: field.maxLength }) } }} />
      )

    case 'folder':
      return <FolderField field={field} value={value} problem={problem} help={help} disabled={disabled} onSet={onSet} chooseFolder={chooseFolder} />

    case 'choice': {
      const index = field.options.findIndex(option => option.value === value)
      return (
        <FormControl error={problem !== undefined} disabled={disabled}>
          <FormLabel id={`${id}-label`}>{field.label}</FormLabel>
          <RadioGroup aria-labelledby={`${id}-label`} aria-describedby={help ? `${id}-help` : undefined}
            value={index === -1 ? '' : String(index)} onChange={(_event, chosen) => onSet(field.options[Number(chosen)].value)}>
            {field.options.map((option, i) => (
              // The option's name is its label; what it means is its description, read out with it
              <Box key={i} sx={{ mb: option.description ? 0.75 : 0 }}>
                <FormControlLabel value={String(i)} label={option.label}
                  control={<Radio size="small" slotProps={{ input: { 'aria-describedby': option.description ? `${id}-option-${i}` : undefined } }} />} />
                {option.description && (
                  <Typography id={`${id}-option-${i}`} variant="caption" color="text.secondary" sx={{ display: 'block', ml: 3.75, mt: -0.75 }}>
                    {option.description}
                  </Typography>
                )}
              </Box>
            ))}
          </RadioGroup>
          {help && <FormHelperText id={`${id}-help`}>{help}</FormHelperText>}
        </FormControl>
      )
    }
  }
}

/**
 * A folder: shown as a path that isn't typed into, chosen with the platform's folder dialog (Browse…); Default clears
 * it, and the placeholder says what the default is.
 */
function FolderField({ field, value, problem, help, disabled, onSet, chooseFolder }: {
  field: FolderSettingsField
  value: unknown
  problem?: string
  help?: string
  disabled: boolean
  onSet(value: string): void
  chooseFolder?(request: SettingsChooseFolder): Promise<string | undefined>
}) {
  const folder = typeof value === 'string' ? value : ''
  const browse = async () => {
    const chosen = await chooseFolder?.({ title: field.label, ...((folder || field.placeholder) && { defaultPath: folder || field.placeholder }) })
    if (chosen) onSet(chosen)
  }
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
      <TextField size="small" fullWidth label={field.label} value={folder} placeholder={field.placeholder} disabled={disabled}
        error={problem !== undefined} helperText={help}
        slotProps={{ htmlInput: { readOnly: true }, inputLabel: { shrink: true } }} />
      <Button onClick={browse} disabled={disabled || !chooseFolder} sx={{ flexShrink: 0, mt: 0.25 }}>Browse…</Button>
      <Button onClick={() => onSet('')} disabled={disabled || folder === ''} sx={{ flexShrink: 0, mt: 0.25 }}>Default</Button>
    </Stack>
  )
}

function NumberField({ field, value, problem, help, disabled, typed, onType }: {
  field: NumberSettingsField
  value: unknown
  problem?: string
  help?: string
  disabled: boolean
  typed?: string
  onType(text: string): void
}) {
  const shown = typed ?? (typeof value === 'number' ? String(value) : '')
  return (
    <TextField size="small" label={field.label} value={shown} disabled={disabled} error={problem !== undefined} helperText={help}
      onChange={event => onType(event.target.value)} sx={{ maxWidth: 240 }}
      slotProps={{
        htmlInput: { inputMode: field.integer ? 'numeric' : 'decimal' },
        ...(field.unit !== undefined && { input: { endAdornment: <InputAdornment position="end">{field.unit}</InputAdornment> } })
      }} />
  )
}
