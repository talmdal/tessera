// shared/dialogs/types.ts — the wire contract between the main process and a window's dialog host.
import { channelFor } from '@tessera/types'
import type { DialogSize, PromptOptions } from '@tessera/types'
import { SHELL_CONTRIBUTOR_ID } from '../plugins/manifest'

export { DIALOGS_EXTENSION_POINT } from '@tessera/types'

const shell = (event: string) => channelFor(SHELL_CONTRIBUTOR_ID, event)

/** Push event, main → renderer: `DialogOpen`. Only the window named in it shows the dialog. */
export const DIALOG_OPEN = shell('dialog.open')

/** Request, renderer → main: `DialogClose`. Accepted only from the window the dialog was sent to. */
export const DIALOG_CLOSE = shell('dialog.close')

/** A valid dialog contribution, with what the renderer needs to load it. */
export interface DialogDescriptor {
  id: string
  title: string
  module: string
  size: DialogSize
  pluginId: string
  /**
   * URL of the plugin's federation remote entry. Absent for the shell's own dialogs, whose components the renderer
   * already has (looked up by `module`).
   */
  remoteEntry?: string
}

export interface DialogOpen {
  windowId: number
  /** Unique per request. A repeat of one already open (after the page reloaded, say) is ignored. */
  requestId: string
  dialog: DialogDescriptor
  /** The title to show: the caller's, or the contribution's. */
  title: string
  input?: unknown
}

export type DialogClose =
  | { requestId: string, result?: unknown }
  /** The dialog could not be shown (its module failed to load or threw). The caller gets undefined. */
  | { requestId: string, error: string }

/** The shell's own text prompt, shown by `shell.prompts.prompt`. Its component is built into the renderer. */
export const PROMPT_DIALOG = 'shell.prompt'
export const PROMPT_DIALOG_MODULE = './Prompt'

/** The prompt dialog's input: `PromptOptions` with its defaults filled in, less the window. */
export type PromptInput = Required<Pick<PromptOptions, 'message' | 'confirmLabel' | 'required'>> &
  Pick<PromptOptions, 'label' | 'defaultValue' | 'placeholder' | 'maxLength'>
