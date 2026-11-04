import { useState } from 'react'
import type { DialogProps } from '@tessera/types'
import { Button, DialogActions, DialogContent, TextField } from '@tessera/ui'

/** A dialog written the way a plugin should: the shell draws the frame, this draws the content and the buttons. */
export default function NameDialog({ input, close, setBusy }: DialogProps<{ name: string }, { name: string }>) {
  const [name, setName] = useState(input.name)
  return (
    <>
      <DialogContent>
        <TextField label="Name" value={name} onChange={event => setName(event.target.value)} />
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setBusy(true)}>Hold</Button>
        <Button onClick={() => close()}>Cancel</Button>
        <Button onClick={() => close({ name })}>Save</Button>
      </DialogActions>
    </>
  )
}
