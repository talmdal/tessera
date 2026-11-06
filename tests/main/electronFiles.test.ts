// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createElectronFiles, FilesPlatform } from '../../shell/main/dialogs/electronFiles'
import { createTempModulesDir } from '../helpers/tempModules'

function setup(focused: unknown = { id: 1 }) {
  const platform = {
    dialog: {
      showOpenDialog: vi.fn(async (..._args: any[]) => ({ canceled: false, filePaths: ['/home/me/Home.tessera'] })),
      showSaveDialog: vi.fn(async (..._args: any[]): Promise<{ canceled: boolean, filePath?: string }> => ({ canceled: false, filePath: '/home/me/New.tessera' }))
    },
    shell: { trashItem: vi.fn(async () => {}) },
    app: { getPath: vi.fn((name: 'documents' | 'downloads') => name === 'downloads' ? '/home/me/Downloads' : '/home/me/Documents') },
    BrowserWindow: { getFocusedWindow: vi.fn(() => focused), fromId: vi.fn((id: number) => ({ id })) }
  } satisfies FilesPlatform
  return { platform, files: createElectronFiles(platform) }
}

const filters = [{ name: 'Tessera ledger', extensions: ['tessera'] }]

describe('shell.files', () => {
  it('opens one file, modal to the focused window, with the filters and labels given', async () => {
    const { files, platform } = setup()
    await expect(files.showOpenDialog({ title: 'Open Ledger', filters, defaultPath: '/home/me', buttonLabel: 'Open' })).resolves.toBe('/home/me/Home.tessera')
    expect(platform.dialog.showOpenDialog).toHaveBeenCalledWith({ id: 1 }, {
      title: 'Open Ledger', defaultPath: '/home/me', buttonLabel: 'Open', filters, properties: ['openFile']
    })
  })

  it('opens several files at once, modal to the focused window, with the filters and labels given', async () => {
    const { files, platform } = setup()
    const statements = [{ name: 'All supported statements', extensions: ['ofx', 'qfx', 'csv'] }]
    platform.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/dl/October.ofx', '/dl/November.ofx'] })
    await expect(files.showOpenFilesDialog({ title: 'Import', filters: statements, defaultPath: '/dl', buttonLabel: 'Import' }))
      .resolves.toEqual(['/dl/October.ofx', '/dl/November.ofx'])
    expect(platform.dialog.showOpenDialog).toHaveBeenCalledWith({ id: 1 }, {
      title: 'Import', defaultPath: '/dl', buttonLabel: 'Import', filters: statements, properties: ['openFile', 'multiSelections']
    })
  })

  it('gives one file as a list of one, and an empty list when the dialog is cancelled', async () => {
    const { files, platform } = setup()
    await expect(files.showOpenFilesDialog()).resolves.toEqual(['/home/me/Home.tessera'])
    platform.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    await expect(files.showOpenFilesDialog()).resolves.toEqual([])
    // Some platforms report the paths chosen before the cancel; a cancelled dialog still chooses nothing
    platform.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: ['/dl/October.ofx'] })
    await expect(files.showOpenFilesDialog()).resolves.toEqual([])
  })

  it('opens several files unparented when there is no window, and in the window asked for', async () => {
    const none = setup(null)
    await none.files.showOpenFilesDialog()
    expect(none.platform.dialog.showOpenDialog).toHaveBeenCalledWith({ properties: ['openFile', 'multiSelections'] })
    const asked = setup()
    await asked.files.showOpenFilesDialog({ windowId: 9 })
    expect(asked.platform.dialog.showOpenDialog).toHaveBeenCalledWith({ id: 9 }, expect.objectContaining({ properties: ['openFile', 'multiSelections'] }))
  })

  it('resolves undefined when either dialog is cancelled', async () => {
    const { files, platform } = setup()
    platform.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    platform.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true })
    await expect(files.showOpenDialog()).resolves.toBeUndefined()
    await expect(files.showSaveDialog()).resolves.toBeUndefined()
  })

  it('saves with the platform asking before replacing a file, unparented when there is no window', async () => {
    const { files, platform } = setup(null)
    await expect(files.showSaveDialog({ defaultPath: '/home/me/Documents/My Finances.tessera', filters })).resolves.toBe('/home/me/New.tessera')
    expect(platform.dialog.showSaveDialog).toHaveBeenCalledWith({
      defaultPath: '/home/me/Documents/My Finances.tessera', filters, properties: ['showOverwriteConfirmation', 'createDirectory']
    })
  })

  it('uses the window asked for', async () => {
    const { files, platform } = setup()
    await files.showSaveDialog({ windowId: 9 })
    expect(platform.dialog.showSaveDialog).toHaveBeenCalledWith({ id: 9 }, expect.any(Object))
  })

  it('sends files to the OS trash, and never deletes them itself', async () => {
    const { files, platform } = setup()
    await files.trash('/home/me/Old.tessera')
    expect(platform.shell.trashItem).toHaveBeenCalledWith('/home/me/Old.tessera')
  })

  it('says whether a file exists, and where the documents and downloads folders are', async () => {
    const { files } = setup()
    const dir = createTempModulesDir()
    const file = path.join(dir, 'Home.tessera')
    fs.writeFileSync(file, '')
    await expect(files.exists(file)).resolves.toBe(true)
    await expect(files.exists(path.join(dir, 'missing.tessera'))).resolves.toBe(false)
    expect(files.documentsPath()).toBe('/home/me/Documents')
    expect(files.downloadsPath()).toBe('/home/me/Downloads')
  })
})
