import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { ThemeSnapshot } from '@tessera/types'
import { THEME_INITIAL } from '../../shared/theme/types'
import { registerInitialTheme } from '../../shell/main/theme/initialTheme'
import { createLogger } from '../helpers/runtime'
import { DEFAULT_FONT_SETTINGS } from '../../shared/fonts/resolveFonts'

const snapshot: ThemeSnapshot = {
  state: { windowId: 1, global: { theme: 'tessera.default', mode: 'system' }, theme: 'tessera.default', mode: 'dark' },
  themes: [],
  fonts: DEFAULT_FONT_SETTINGS
}

/** Registers the handler and returns a function that sends a synchronous request, as the preload does. */
function setup(snapshotFor: (windowId: number) => ThemeSnapshot | undefined, log = createLogger()) {
  registerInitialTheme(snapshotFor, log)
  const [channel, handler] = vi.mocked(electron.ipcMain.on).mock.calls.at(-1)!
  expect(channel).toBe(THEME_INITIAL)

  return (windowId?: number) => {
    vi.spyOn(electron.BrowserWindow, 'fromWebContents').mockReturnValue(windowId === undefined ? null : { id: windowId } as never)
    const event: any = { sender: {} }
    ;(handler as any)(event)
    return event.returnValue
  }
}

describe('registerInitialTheme', () => {
  beforeEach(() => { vi.mocked(electron.ipcMain.on).mockClear() })

  it("answers with the sending window's snapshot", () => {
    const snapshotFor = vi.fn(() => snapshot)
    const ask = setup(snapshotFor)

    expect(ask(1)).toBe(snapshot)
    expect(snapshotFor).toHaveBeenCalledWith(1)
  })

  it('answers null for a window the theme manager does not know', () => {
    expect(setup(() => undefined)(5)).toBeNull()
  })

  it('answers null when the sender is not a window', () => {
    const snapshotFor = vi.fn(() => snapshot)

    expect(setup(snapshotFor)(undefined)).toBeNull()
    expect(snapshotFor).not.toHaveBeenCalled()
  })

  it('logs and answers null if it throws, so a page never hangs on it', () => {
    const log = createLogger()
    const ask = setup(() => { throw new Error('boom') }, log)

    expect(ask(1)).toBeNull()
    expect(log.error).toHaveBeenCalledWith('[theme] Could not answer the initial theme request', expect.any(Error))
  })
})
