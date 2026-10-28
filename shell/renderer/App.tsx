import { LayoutController } from './layout/LayoutController'

export default function App() {
  return <LayoutController welcome={<Welcome />} />
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
