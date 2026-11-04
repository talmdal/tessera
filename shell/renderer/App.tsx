import { Typography } from '@tessera/ui'
import { LayoutController } from './layout/LayoutController'

export default function App() {
  return <LayoutController welcome={<Welcome />} />
}

/** Shown when no plugin contributes to the main slot. */
function Welcome() {
  return (
    <>
      <Typography variant="h4" component="h1" gutterBottom>Tessera</Typography>
      <Typography>Renderer shell is running.</Typography>
    </>
  )
}
