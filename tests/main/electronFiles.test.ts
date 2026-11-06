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
    app: { getPath: vi.fn(() => '/home/me/Documents') },
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

  it('says whether a file exists, and where the documents folder is', async () => {
    const { files } = setup()
    const dir = createTempModulesDir()
    const file = path.join(dir, 'Home.tessera')
    fs.writeFileSync(file, '')
    await expect(files.exists(file)).resolves.toBe(true)
    await expect(files.exists(path.join(dir, 'missing.tessera'))).resolves.toBe(false)
    expect(files.documentsPath()).toBe('/home/me/Documents')
  })
})
