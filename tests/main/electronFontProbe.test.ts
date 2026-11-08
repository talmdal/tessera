// The Electron side of listing fonts, with Electron's pieces faked: a hidden window on a session of its own, the only
// page granted `local-fonts`, asked once and closed.
import { describe, expect, it, vi } from 'vitest'
import { FONT_PROBE_PARTITION, FONT_PROBE_SCRIPT, createElectronFontProbe } from '../../shell/main/fonts/electronFontProbe'

function fakeElectron(answer: () => Promise<unknown> = async () => ['Inter', 'Consolas'], load: () => Promise<void> = async () => {}) {
  const handlers: { check?: (wc: any, permission: string) => boolean, request?: (wc: any, permission: string, cb: (granted: boolean) => void) => void } = {}
  const session = {
    setPermissionCheckHandler: vi.fn(handler => { handlers.check = handler }),
    setPermissionRequestHandler: vi.fn(handler => { handlers.request = handler })
  }
  const windows: any[] = []
  const BrowserWindow = vi.fn(function (this: any, options: any) {
    let destroyed = false
    const win = {
      options,
      webContents: { id: 40 + windows.length, executeJavaScript: vi.fn(async () => answer()) },
      loadFile: vi.fn(async () => load()),
      destroy: vi.fn(() => { destroyed = true }),
      isDestroyed: () => destroyed
    }
    windows.push(win)
    return win
  })
  const electron = { BrowserWindow: BrowserWindow as any, session: { fromPartition: vi.fn(() => session) as any } }
  return { electron, session, handlers, windows }
}

describe('the font probe', () => {
  it('asks a hidden window of its own, on a session of its own, loading the probe page, then closes it', async () => {
    const { electron, windows } = fakeElectron()

    const families = await createElectronFontProbe(electron, '/app/font-probe.html').listFamilies()

    expect(families).toEqual(['Inter', 'Consolas'])
    expect(electron.session.fromPartition).toHaveBeenCalledWith(FONT_PROBE_PARTITION)
    expect(FONT_PROBE_PARTITION.startsWith('persist:')).toBe(false)
    expect(windows).toHaveLength(1)
    expect(windows[0].options).toMatchObject({ show: false, webPreferences: { partition: FONT_PROBE_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false } })
    expect(windows[0].loadFile).toHaveBeenCalledWith('/app/font-probe.html')
    expect(windows[0].webContents.executeJavaScript).toHaveBeenCalledWith(FONT_PROBE_SCRIPT, true)
    expect(windows[0].destroy).toHaveBeenCalled()
  })

  it('grants local-fonts to the probe page only, and nothing else to it', async () => {
    const { electron, handlers, windows } = fakeElectron()
    await createElectronFontProbe(electron, '/app/font-probe.html').listFamilies()
    const probe = windows[0].webContents

    expect(handlers.check!(probe, 'local-fonts')).toBe(true)
    expect(handlers.check!({ id: 999 }, 'local-fonts')).toBe(false)
    expect(handlers.check!(null, 'local-fonts')).toBe(false)
    expect(handlers.check!(probe, 'media')).toBe(false)
    const granted = (wc: any, permission: string) => { let answer: boolean | undefined; handlers.request!(wc, permission, g => { answer = g }); return answer }
    expect(granted(probe, 'local-fonts')).toBe(true)
    expect(granted({ id: 999 }, 'local-fonts')).toBe(false)
    expect(granted(probe, 'notifications')).toBe(false)
  })

  it('closes the window when the page or the question fails, and lets the failure through', async () => {
    const failedLoad = fakeElectron(undefined, async () => { throw new Error('no page') })
    await expect(createElectronFontProbe(failedLoad.electron, '/x.html').listFamilies()).rejects.toThrow('no page')
    expect(failedLoad.windows[0].destroy).toHaveBeenCalled()

    const failedQuery = fakeElectron(async () => { throw new Error('SecurityError') })
    await expect(createElectronFontProbe(failedQuery.electron, '/x.html').listFamilies()).rejects.toThrow('SecurityError')
    expect(failedQuery.windows[0].destroy).toHaveBeenCalled()
  })
})
