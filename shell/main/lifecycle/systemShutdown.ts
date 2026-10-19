// shell/main/lifecycle/systemShutdown.ts
import { BrowserWindow, powerMonitor } from 'electron'
import shutdownHandler from '@paymoapp/electron-shutdown-handler'
import { SystemShutdownSource } from './quit'

/**
 * The ways this platform reports an OS shutdown or logoff. Call once the main
 * window exists, and after Electron's `ready` event (powerMonitor needs it).
 *
 * - Linux and macOS: Electron's `powerMonitor` 'shutdown' event;
 *   `preventDefault()` asks the OS to wait for the app.
 * - Windows: Electron has no equivalent, so the native shutdown handler hooks
 *   the main window. It must be given the window handle before anything
 *   listens, and it only delays the shutdown once `blockShutdown` is called,
 *   which `preventDefault()` does here.
 */
export function osShutdownSources(window: BrowserWindow): SystemShutdownSource[] {
  const sources: SystemShutdownSource[] = [
    listener => { powerMonitor.on('shutdown', (event: { preventDefault(): void }) => listener(event)) }
  ]

  if (process.platform === 'win32') {
    shutdownHandler.setWindowHandle(window.getNativeWindowHandle())
    sources.push(listener => {
      shutdownHandler.on('shutdown', () =>
        listener({ preventDefault: () => { shutdownHandler.blockShutdown('Tessera is saving your data') } }))
    })
  }

  return sources
}
