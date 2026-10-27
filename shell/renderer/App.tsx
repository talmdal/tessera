import { WindowManager } from './layout/WindowManager'
import { ThemeChooser } from './theme/ThemeChooser'

export default function App() {
  return (
    <>
      <WindowManager fallback={<Welcome />} />
      <ThemeChooser />
    </>
  )
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
