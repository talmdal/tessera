// shell/renderer/dialogs/PromptDialog.tsx — the shell's own dialog behind `shell.prompts.prompt`.
import { FormEvent, useId, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import { Button, DialogActions, DialogContent, TextField, Typography } from '@tessera/ui'
import type { PromptInput } from '../../../shared/dialogs/types'

/** Asks for a line of text. Enter submits; an empty answer can't be submitted when one is required. */
export function PromptDialog({ input, close }: DialogProps<PromptInput, string>) {
  const messageId = useId()
  const [value, setValue] = useState(input.defaultValue ?? '')
  const invalid = input.required && value.trim() === ''

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!invalid) close(value.trim())
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogContent>
        <Typography id={messageId} sx={{ mb: 1 }}>{input.message}</Typography>
        <TextField
          autoFocus
          fullWidth
          size="small"
          label={input.label}
          placeholder={input.placeholder}
          value={value}
          onChange={event => setValue(event.target.value)}
          slotProps={{
            htmlInput: {
              'aria-describedby': messageId,
              ...(input.label === undefined && { 'aria-label': input.message }),
              ...(input.maxLength !== undefined && { maxLength: input.maxLength })
            }
          }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close()}>Cancel</Button>
        <Button type="submit" variant="contained" disabled={invalid}>{input.confirmLabel}</Button>
      </DialogActions>
    </form>
  )
}
