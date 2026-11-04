// shell/main/dialogs/electronPrompts.ts — `shell.prompts` over Electron's native message boxes and the dialog host.
import type {
  ConfirmOptions, DialogTarget, MessageOptions, PromptOptions, ShellPrompts, ShowDialogOptions
} from '@tessera/types'
import { PROMPT_DIALOG, PromptInput } from '../../../shared/dialogs/types'

/** The parts of Electron this needs, so tests can pass fakes. */
export interface PromptsPlatform {
  dialog: {
    showMessageBox(...args: any[]): Promise<{ response: number }>
  }
  BrowserWindow: {
    getFocusedWindow(): unknown
    fromId(id: number): unknown
  }
}

export interface DialogShower {
  show(dialogId: string, input?: unknown, options?: ShowDialogOptions): Promise<unknown>
}

/** The window a native box is modal to: the one asked for, else the focused one. None: an unparented box. */
export function parentWindow(platform: Pick<PromptsPlatform, 'BrowserWindow'>, { windowId }: DialogTarget) {
  return (windowId !== undefined ? platform.BrowserWindow.fromId(windowId) : platform.BrowserWindow.getFocusedWindow()) ?? undefined
}

async function messageBox(platform: PromptsPlatform, target: DialogTarget, options: Record<string, unknown>) {
  const parent = parentWindow(platform, target)
  const { response } = parent
    ? await platform.dialog.showMessageBox(parent, options)
    : await platform.dialog.showMessageBox(options)
  return response
}

export function createElectronPrompts(platform: PromptsPlatform, dialogs: DialogShower): ShellPrompts {
  return {
    async confirm(options: ConfirmOptions) {
      const buttons = [options.confirmLabel ?? 'OK', options.cancelLabel ?? 'Cancel']
      const response = await messageBox(platform, options, {
        type: options.destructive ? 'warning' : 'question',
        buttons,
        // For a destructive action Enter must not carry it out: Cancel is the default
        defaultId: options.destructive ? 1 : 0,
        cancelId: 1,
        noLink: true,
        message: options.message,
        ...(options.detail !== undefined && { detail: options.detail }),
        ...(options.title !== undefined && { title: options.title })
      })
      return response === 0
    },

    async message(options: MessageOptions) {
      await messageBox(platform, options, {
        type: options.kind ?? 'info',
        buttons: [options.buttonLabel ?? 'OK'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        message: options.message,
        ...(options.detail !== undefined && { detail: options.detail }),
        ...(options.title !== undefined && { title: options.title })
      })
    },

    async prompt(options: PromptOptions) {
      const input: PromptInput = {
        message: options.message,
        confirmLabel: options.confirmLabel ?? 'OK',
        required: options.required ?? true,
        ...(options.label !== undefined && { label: options.label }),
        ...(options.defaultValue !== undefined && { defaultValue: options.defaultValue }),
        ...(options.placeholder !== undefined && { placeholder: options.placeholder }),
        ...(options.maxLength !== undefined && { maxLength: options.maxLength })
      }
      const answer = await dialogs.show(PROMPT_DIALOG, input, {
        title: options.title ?? 'Tessera',
        ...(options.windowId !== undefined && { windowId: options.windowId })
      })
      return typeof answer === 'string' ? answer.trim() : undefined
    },

    show<TResult = unknown>(dialogId: string, input?: unknown, options?: ShowDialogOptions) {
      return dialogs.show(dialogId, input, options) as Promise<TResult | undefined>
    }
  }
}
