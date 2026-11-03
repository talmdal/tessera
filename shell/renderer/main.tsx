// shell/renderer/main.tsx — renderer composition root.
import { createRoot } from 'react-dom/client'
import App from './App'
import { BarItemsProvider, createIpcBarItemSource } from './layout/BarItemsProvider'
import { ShellStateProvider } from './state/ShellState'
import { ShellThemeProvider } from './theme/ShellThemeProvider'
import { createFederationViewLoader } from './views/federationViewLoader'
import { createIpcViewSource } from './views/ipcViewSource'
import { ViewsProvider } from './views/ViewsProvider'

const source = createIpcViewSource(window.api)
const barItems = createIpcBarItemSource(window.api)
const loader = createFederationViewLoader()

const root = createRoot(document.getElementById('root')!)
// The theme is outermost, so everything below it, including the providers' own fallbacks, is themed.
root.render(
  <ShellThemeProvider bridge={window.api}>
    <ShellStateProvider bridge={window.api}>
      <ViewsProvider source={source} loader={loader}>
        <BarItemsProvider source={barItems}>
          <App />
        </BarItemsProvider>
      </ViewsProvider>
    </ShellStateProvider>
  </ShellThemeProvider>
)
