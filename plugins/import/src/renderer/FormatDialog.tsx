// Choose a Format: shown when more than one installed format could read a file.
import { FormEvent, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import type { FormatDialogInput, FormatDialogResult } from '@tessera/import-api'
import { Button, DialogActions, DialogContent, FormControlLabel, Radio, RadioGroup, Stack, Typography } from '@tessera/ui'

export default function FormatDialog({ input, close }: DialogProps<FormatDialogInput, FormatDialogResult>) {
  const [formatId, setFormatId] = useState(input.formats[0]?.id ?? '')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (formatId) close({ formatId })
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogContent>
        <Stack spacing={1.5}>
          <Typography id="format-question">More than one kind of file could be {input.fileName}. Which is it?</Typography>
          <RadioGroup aria-labelledby="format-question" value={formatId} onChange={event => setFormatId(event.target.value)}>
            {input.formats.map(format => (
              <FormControlLabel key={format.id} value={format.id} control={<Radio size="small" />} sx={{ alignItems: 'flex-start', mb: 0.5 }}
                label={
                  <Stack sx={{ pt: 0.75 }}>
                    <Typography>{format.label}</Typography>
                    {format.description && <Typography variant="body2" color="text.secondary">{format.description}</Typography>}
                  </Stack>
                } />
            ))}
          </RadioGroup>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close()}>Cancel</Button>
        <Button type="submit" variant="contained" disabled={!formatId}>Choose</Button>
      </DialogActions>
    </form>
  )
}
