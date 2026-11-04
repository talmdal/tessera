// shell/main/theme/initialTheme.ts
import { BrowserWindow, ipcMain } from 'electron'
import type { ThemeSnapshot } from '@tessera/types'
import { THEME_INITIAL } from '../../../shared/theme/types'

/**
 * Answers the preload's synchronous request for its window's theme, so the page
 * can render in the right colours on its first frame. `snapshotFor` returns
 * undefined for a window the theme manager does not know, which is answered with
 * `null`. A throw is logged and answered the same way, so a page never hangs on it.
 */
export function registerInitialTheme(
  snapshotFor: (windowId: number) => ThemeSnapshot | undefined,
  log: { error(message: string, ...rest: unknown[]): void }
) {
  ipcMain.on(THEME_INITIAL, event => {
    try {
      const windowId = BrowserWindow.fromWebContents(event.sender)?.id
      event.returnValue = (windowId === undefined ? undefined : snapshotFor(windowId)) ?? null
    } catch (err) {
      log.error('[theme] Could not answer the initial theme request', err)
      event.returnValue = null
    }
  })
}
