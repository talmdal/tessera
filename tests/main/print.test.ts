// @vitest-environment node
// `shell.print` (phase R6) against fake windows: the system's print dialog for the window asked for (else the focused
// one), in the orientation asked for, backgrounds never printed; a cancelled print is no error, a failed one says why;
// a PDF on the paper of the user's region, written whole or not at all; provided before any plugin activates.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SHELL_PRINT_SERVICE, type ShellFiles } from '@tessera/types'
import { DialogService } from '../../core/dialogs/DialogService'
import { createPluginContext, createPluginRuntime } from '../../core/plugins/PluginContext'
import { SHELL_CONTRIBUTOR_ID } from '../../shared/plugins/manifest'
import { createElectronPrompts } from '../../shell/main/dialogs/electronPrompts'
import { registerDialogs } from '../../shell/main/dialogs/registerDialogs'
import { nodeWriteDisk, writeFileAtomically } from '../../shell/main/dialogs/writeFile'
import { createElectronPrint, paperFor, type PrintPlatform } from '../../shell/main/print/electronPrint'
import { createLogger } from '../helpers/runtime'
import { createTempModulesDir } from '../helpers/tempModules'

/** A window whose print dialog answers as told, and whose PDF is some bytes. */
function fakeWindow(id: number, answer: [boolean, string] = [true, '']) {
  const webContents = {
    print: vi.fn((_options: Record<string, unknown>, callback: (success: boolean, reason: string) => void) => { setTimeout(() => callback(...answer), 0) }),
    printToPDF: vi.fn(async (_options: Record<string, unknown>) => new TextEncoder().encode(`%PDF-1.4 window ${id}`))
  }
  return { id, webContents, isDestroyed: () => false }
}

function setup(options: { focused?: ReturnType<typeof fakeWindow> | null, region?: string } = {}) {
  const windows = [fakeWindow(1), fakeWindow(2)]
  const focused = options.focused === undefined ? windows[0] : options.focused
  const written: string[] = []
  const platform = {
    BrowserWindow: { getFocusedWindow: () => focused, fromId: (id: number) => windows.find(w => w.id === id) ?? null, getAllWindows: () => windows },
    app: { getLocaleCountryCode: () => options.region ?? 'CA' },
    writeFile: vi.fn(async (file: string, data: Uint8Array) => { written.push(file); await writeFileAtomically(nodeWriteDisk, file, data) })
  } satisfies PrintPlatform
  return { windows, platform, print: createElectronPrint(platform), written }
}

describe('shell.print', () => {
  it('opens the system\'s print dialog for the focused window, portrait unless asked, without backgrounds; true once printed', async () => {
    const { print, windows } = setup()
    await expect(print.print()).resolves.toBe(true)
    expect(windows[0].webContents.print).toHaveBeenCalledWith({ silent: false, printBackground: false, landscape: false }, expect.any(Function))
    await expect(print.print({ windowId: 2, landscape: true })).resolves.toBe(true)
    expect(windows[1].webContents.print).toHaveBeenCalledWith({ silent: false, printBackground: false, landscape: true }, expect.any(Function))
  })

  it('resolves false when the user cancels, and rejects saying why when printing fails', async () => {
    const cancelled = setup({ focused: fakeWindow(3, [false, 'Print job canceled']) })
    await expect(cancelled.print.print()).resolves.toBe(false)
    const failed = setup({ focused: fakeWindow(4, [false, 'Print job failed']) })
    await expect(failed.print.print()).rejects.toThrow('The report couldn’t be printed: Print job failed.')
  })

  it('prints the first window when none is focused, and says so when there is none', async () => {
    const { print, windows } = setup({ focused: null })
    await print.print()
    expect(windows[0].webContents.print).toHaveBeenCalled()
    const none = createElectronPrint({
      BrowserWindow: { getFocusedWindow: () => null, fromId: () => null, getAllWindows: () => [] },
      app: { getLocaleCountryCode: () => 'CA' }, writeFile: vi.fn()
    })
    await expect(none.print()).rejects.toThrow('There is no window to print.')
  })

  it('writes the window as a PDF, whole, on the paper of the user\'s region, in the orientation asked for', async () => {
    const dir = createTempModulesDir()
    const { print, windows, written } = setup({ region: 'CA' })
    const file = path.join(dir, 'Net Worth 2026.pdf')
    await print.savePdf({ path: file, landscape: true, windowId: 2 })
    expect(windows[1].webContents.printToPDF).toHaveBeenCalledWith({ landscape: true, pageSize: 'Letter', printBackground: false })
    expect(fs.readFileSync(file, 'utf8')).toBe('%PDF-1.4 window 2')
    expect(written).toEqual([file])
    expect(fs.readdirSync(dir)).toEqual(['Net Worth 2026.pdf'])
    // In France, A4; a page size asked for wins
    const france = setup({ region: 'fr' })
    await france.print.savePdf({ path: path.join(dir, 'a.pdf') })
    expect(france.windows[0].webContents.printToPDF).toHaveBeenCalledWith({ landscape: false, pageSize: 'A4', printBackground: false })
    await france.print.savePdf({ path: path.join(dir, 'b.pdf'), pageSize: 'Letter' })
    expect(france.windows[0].webContents.printToPDF).toHaveBeenLastCalledWith({ landscape: false, pageSize: 'Letter', printBackground: false })
  })

  it('says why a PDF couldn\'t be made, and writes nothing', async () => {
    const dir = createTempModulesDir()
    const { print, windows, platform } = setup()
    windows[0].webContents.printToPDF.mockRejectedValueOnce(new Error('Printing failed'))
    await expect(print.savePdf({ path: path.join(dir, 'Report.pdf') })).rejects.toThrow('Report.pdf couldn’t be saved: Printing failed')
    expect(platform.writeFile).not.toHaveBeenCalled()
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('knows which regions use US Letter', () => {
    expect(['US', 'CA', 'MX', 'PH', 'cl'].map(paperFor)).toEqual(['Letter', 'Letter', 'Letter', 'Letter', 'Letter'])
    expect(['GB', 'FR', 'DE', 'JP', 'AU', ''].map(paperFor)).toEqual(['A4', 'A4', 'A4', 'A4', 'A4', 'A4'])
  })

  it('is provided by the shell before any plugin activates', () => {
    const runtime = createPluginRuntime(undefined, createLogger())
    const shell = createPluginContext(SHELL_CONTRIBUTOR_ID, runtime).context
    const dialogs = new DialogService(runtime.extensions, runtime.events, { remoteEntryFor: () => undefined, targetWindow: () => 1, log: createLogger() })
    const { print } = setup()
    registerDialogs(shell, runtime, dialogs, {
      prompts: createElectronPrompts({ dialog: { showMessageBox: vi.fn() }, BrowserWindow: { getFocusedWindow: () => null, fromId: () => null } }, dialogs),
      files: {} as ShellFiles, print
    })
    expect(runtime.services.providerOf(SHELL_PRINT_SERVICE)).toBe('shell')
    expect(runtime.services.get(SHELL_PRINT_SERVICE)).toBe(print)
  })
})
