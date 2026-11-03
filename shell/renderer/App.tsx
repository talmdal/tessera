import { Typography } from '@mui/material'
import { LayoutController } from './layout/LayoutController'
import { ThemePickerHost } from './theme/ThemePickerHost'

export default function App() {
  return (
    <>
      <LayoutController welcome={<Welcome />} />
      <ThemePickerHost />
    </>
  )
}

/** Shown when no plugin contributes to the main slot. */
function Welcome() {
  return (
    <>
      <Typography variant="h4" component="h1" gutterBottom>Tessera</Typography>
      <Typography color="text.secondary">Renderer shell is running.</Typography>
    </>
  )
}
