import { useEffect, useState } from 'react'
import { Button, useTheme } from '@mui/material'
import { Icon } from '@tessera/ui'

/**
 * Uses the three things a plugin view may import, React, @mui/material and
 * @tessera/ui, so the test can prove each arrives from the shell's share
 * scope: hooks work (one React), and the theme it reads is the shell's.
 */
export default function HelloView() {
  const [greeting, setGreeting] = useState('…')
  const theme = useTheme()

  useEffect(() => {
    window.api.invoke<string>('sample-builtin:hello').then(setGreeting)
  }, [])

  return (
    <div id="hello-tsx">
      <h2>Hello from TSX</h2>
      <p>Backend says: {greeting}</p>
      <p>Theme mode: {theme.palette.mode}</p>
      <p>Credit colour: {theme.tessera?.finance.credit ?? 'none'}</p>
      <Button startIcon={<Icon name="Save" />}>Save</Button>
    </div>
  )
}
