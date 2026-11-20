// shell/main/dialogs/electronFiles.ts — `shell.files` over Electron's file and folder dialogs and the OS trash.
import fs from 'node:fs'
import type { FileDialogOptions, ShellFiles } from '@tessera/types'
import { parentWindow, PromptsPlatform } from './electronPrompts'

/** The parts of Electron this needs, so tests can pass fakes. */
export interface FilesPlatform extends Pick<PromptsPlatform, 'BrowserWindow'> {
  dialog: {
    showOpenDialog(...args: any[]): Promise<{ canceled: boolean, filePaths: string[] }>
    showSaveDialog(...args: any[]): Promise<{ canceled: boolean, filePath?: string }>
  }
  shell: { trashItem(path: string): Promise<void> }
  app: { getPath(name: 'documents'): string }
}

function dialogOptions(options: FileDialogOptions) {
  return {
    ...(options.title !== undefined && { title: options.title }),
    ...(options.defaultPath !== undefined && { defaultPath: options.defaultPath }),
    ...(options.buttonLabel !== undefined && { buttonLabel: options.buttonLabel }),
    ...(options.filters !== undefined && { filters: options.filters })
  }
}

export function createElectronFiles(platform: FilesPlatform): ShellFiles {
  const withParent = <T>(options: FileDialogOptions, show: (...args: any[]) => Promise<T>, settings: object) => {
    const parent = parentWindow(platform, options)
    return parent ? show(parent, settings) : show(settings)
  }

  return {
    async showOpenDialog(options = {}) {
      const { canceled, filePaths } = await withParent(options, platform.dialog.showOpenDialog.bind(platform.dialog),
        { ...dialogOptions(options), properties: ['openFile'] })
      return canceled || filePaths.length === 0 ? undefined : filePaths[0]
    },

    async showFolderDialog(options = {}) {
      // Filters mean nothing for a folder; dropped even if a caller passed some past the type
      const { filters: _ignored, ...folder } = options as FileDialogOptions
      // createDirectory: the user can make the folder they want from the dialog itself (macOS; the others always can)
      const { canceled, filePaths } = await withParent(folder, platform.dialog.showOpenDialog.bind(platform.dialog),
        { ...dialogOptions(folder), properties: ['openDirectory', 'createDirectory'] })
      return canceled || filePaths.length === 0 ? undefined : filePaths[0]
    },

    async showSaveDialog(options = {}) {
      const { canceled, filePath } = await withParent(options, platform.dialog.showSaveDialog.bind(platform.dialog),
        { ...dialogOptions(options), properties: ['showOverwriteConfirmation', 'createDirectory'] })
      return canceled || !filePath ? undefined : filePath
    },

    async exists(path: string) {
      try {
        await fs.promises.access(path)
        return true
      } catch {
        return false
      }
    },

    trash: path => platform.shell.trashItem(path),

    documentsPath: () => platform.app.getPath('documents')
  }
}
