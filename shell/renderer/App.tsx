import { WindowManager } from './layout/WindowManager'

export default function App() {
  return <WindowManager fallback={<Welcome />} />
}

/** Shown when no plugin contributes a view to the main slot. */
function Welcome() {
  return (
    <>
      <h1>Tessera</h1>
      <p>Renderer shell is running.</p>
    </>
  )
}
