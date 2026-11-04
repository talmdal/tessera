// shell/renderer/main.tsx — renderer composition root.
import { createRoot } from 'react-dom/client'
import type { ShellBridge } from '../../shared/ipc'
import App from './App'
import { IconsProvider } from './icons/IconsProvider'
import { BarItemsProvider, createIpcBarItemSource } from './layout/BarItemsProvider'
import { ShellStateProvider } from './state/ShellState'
import { ShellThemeProvider } from './theme/ShellThemeProvider'
import { ThemeChooser } from './theme/ThemeChooser'
import { createFederationViewLoader } from './views/federationViewLoader'
import { createIpcViewSource } from './views/ipcViewSource'
import { ViewsProvider } from './views/ViewsProvider'
import { WindowReady } from './WindowReady'

const bridge = window.api as ShellBridge
const source = createIpcViewSource(window.api)
const barItems = createIpcBarItemSource(window.api)
const loader = createFederationViewLoader()

const root = createRoot(document.getElementById('root')!)
// Nothing is drawn until the window's theme is known; the main process keeps the window hidden until then.
root.render(
  <ShellThemeProvider bridge={bridge} initial={bridge.initialTheme}>
    <ShellStateProvider bridge={window.api}>
      <IconsProvider bridge={window.api}>
        <ViewsProvider source={source} loader={loader}>
          <BarItemsProvider source={barItems}>
            <App />
            <WindowReady bridge={window.api} />
            <ThemeChooser bridge={window.api} />
          </BarItemsProvider>
        </ViewsProvider>
      </IconsProvider>
    </ShellStateProvider>
  </ShellThemeProvider>
)
