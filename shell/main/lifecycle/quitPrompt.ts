// shell/main/lifecycle/quitPrompt.ts — the question pass 1 of a quit asks when something stands in the way.
import type { PromptsPlatform } from '../dialogs/electronPrompts'
import { parentWindow } from '../dialogs/electronPrompts'
import type { QuitChoice } from './quit'

const BUTTONS = ['Retry', 'Quit Anyway', 'Cancel'] as const

/**
 * "Tessera can't close yet", with every reason pass 1 gave, and three choices: Retry (ask again, say once an import
 * has finished or a backup drive is plugged back in), Quit Anyway, and Cancel, the default, so Enter or Escape keeps
 * the app running. Modal to the focused window; no time limit.
 */
export async function askToQuit(platform: Pick<PromptsPlatform, 'dialog' | 'BrowserWindow'>, reasons: readonly string[]): Promise<QuitChoice> {
  const options = {
    type: 'warning',
    title: 'Tessera',
    message: 'Tessera can’t close yet.',
    detail: reasons.join('\n\n'),
    buttons: [...BUTTONS],
    defaultId: 2,
    cancelId: 2,
    noLink: true
  }
  const parent = parentWindow(platform, {})
  const { response } = parent ? await platform.dialog.showMessageBox(parent, options) : await platform.dialog.showMessageBox(options)
  return response === 0 ? 'retry' : response === 1 ? 'quit' : 'cancel'
}
