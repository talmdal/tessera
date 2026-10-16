import { MAIN_SLOT } from '../../shared/views/types'
import { Slot } from './views/ViewsProvider'

export default function App() {
  return (
    <main style={{ padding: 20 }}>
      <Slot id={MAIN_SLOT} fallback={<Welcome />} />
    </main>
  )
}

/** Shown when no plugin contributes to the main slot. */
function Welcome() {
  return (
    <>
      <h1>Tessera</h1>
      <p>Renderer shell is running.</p>
    </>
  )
}
