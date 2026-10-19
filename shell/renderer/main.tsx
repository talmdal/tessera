// shell/renderer/main.tsx — renderer composition root.
import { createRoot } from 'react-dom/client'
import App from './App'
import { ShellStateProvider } from './state/ShellState'
import { createFederationViewLoader } from './views/federationViewLoader'
import { createIpcViewSource } from './views/ipcViewSource'
import { ViewsProvider } from './views/ViewsProvider'

const source = createIpcViewSource(window.api)
const loader = createFederationViewLoader()

const root = createRoot(document.getElementById('root')!)
root.render(
  <ShellStateProvider bridge={window.api}>
    <ViewsProvider source={source} loader={loader}>
      <App />
    </ViewsProvider>
  </ShellStateProvider>
)
