// Dialogs, prompts and file dialogs: what the shell offers plugins so every plugin asks the user the same way.
//
//  - `shell.prompts` (service): native confirmation and message boxes, a text prompt, and `show`, which opens a
//    dialog a plugin contributed and resolves with what it closed with.
//  - `shell.dialogs` (extension point): a plugin's own modal dialog. The shell draws the frame (modal, title, size,
//    Escape and clicking outside to cancel); the plugin's component draws the content and the buttons.
//  - `shell.files` (service): open and save file dialogs, and moving files to the OS trash.

/** The service id of `ShellPrompts`. The shell provides it before any plugin activates, so `requires` can name it. */
export const SHELL_PROMPTS_SERVICE = 'shell.prompts'

/** The service id of `ShellFiles`. */
export const SHELL_FILES_SERVICE = 'shell.files'

/** Extension point for `DialogContribution`s. */
export const DIALOGS_EXTENSION_POINT = 'shell.dialogs'

/** Widths, as MUI's `maxWidth`; the dialog takes the full width up to it. */
export type DialogSize = 'xs' | 'sm' | 'md' | 'lg'

/**
 * A modal dialog, contributed from a plugin's privileged `activate` as plain data:
 * `context.extensions.contribute(pluginId, DIALOGS_EXTENSION_POINT, id, contribution)`.
 * Open it with `shell.prompts.show(id, input)`.
 */
export interface DialogContribution {
  /** `<pluginId>.<name>`: other plugins can open it by this id. */
  id: string
  /** Shown in the dialog's title bar, and its accessible name. `show` may replace it. */
  title: string
  /** A module the plugin's renderer remote exposes, e.g. "./NewLedgerDialog". Its default export is the component. */
  module: string
  /** Default `'sm'`. */
  size?: DialogSize
}

/**
 * The props of a dialog's component. The shell draws the dialog and its title; the component renders the body
 * (`DialogContent`) and the buttons (`DialogActions`) from `@tessera/ui`.
 */
export interface DialogProps<TInput = unknown, TResult = unknown> {
  /** What the caller passed to `show`. */
  input: TInput
  /**
   * Closes the dialog. With a `result` (structured-cloneable), the caller's `show` resolves with it; without one,
   * the dialog was cancelled and `show` resolves undefined. Later calls are ignored.
   */
  close(result?: TResult): void
  /** While busy (saving, say), Escape and clicking outside don't close the dialog. */
  setBusy(busy: boolean): void
}

/** Which window a dialog belongs to. Default: the focused window, else the first one. */
export interface DialogTarget {
  windowId?: number
}

export interface ConfirmOptions extends DialogTarget {
  /** The question, short: "Move “Home Finances” to the Recycle Bin?" */
  message: string
  /** A sentence or two explaining the consequences. */
  detail?: string
  /** Window title, where the platform shows one. */
  title?: string
  /** Default 'OK'. Name the action: 'Delete', 'Close and Create'. */
  confirmLabel?: string
  /** Default 'Cancel'. */
  cancelLabel?: string
  /**
   * For actions that destroy or discard something. Cancel becomes the default button, so pressing Enter doesn't
   * carry it out, and the box shows as a warning.
   */
  destructive?: boolean
}

export interface MessageOptions extends DialogTarget {
  message: string
  detail?: string
  title?: string
  /** Default 'info'. */
  kind?: 'info' | 'warning' | 'error'
  /** Default 'OK'. */
  buttonLabel?: string
}

export interface PromptOptions extends DialogTarget {
  /** Dialog title. Default 'Tessera'. */
  title?: string
  /** What to enter: "Name of the new sub-ledger". */
  message: string
  /** The text field's label. */
  label?: string
  defaultValue?: string
  placeholder?: string
  /** Default 'OK'. */
  confirmLabel?: string
  /** Default true: an empty (or all-blank) answer can't be submitted. */
  required?: boolean
  maxLength?: number
}

export interface ShowDialogOptions extends DialogTarget {
  /** Replaces the contribution's title, e.g. "Edit Account" for a dialog titled "New Account". */
  title?: string
}

/** The `shell.prompts` service. Every method resolves once the user has answered. */
export interface ShellPrompts {
  /** A native confirmation box. Resolves true only if the user chose the confirm button. */
  confirm(options: ConfirmOptions): Promise<boolean>
  /** A native message box with one button. */
  message(options: MessageOptions): Promise<void>
  /** Asks for a line of text. Resolves undefined if cancelled; the answer is trimmed. */
  prompt(options: PromptOptions): Promise<string | undefined>
  /**
   * Shows a `shell.dialogs` contribution and resolves with what it closed with, or undefined if it was cancelled,
   * its window closed, or it failed to load. Rejects only for a dialog id nobody contributed, or when there is no
   * window. `input` and the result must be structured-cloneable.
   */
  show<TResult = unknown, TInput = unknown>(dialogId: string, input?: TInput, options?: ShowDialogOptions): Promise<TResult | undefined>
}

export interface FileFilter {
  /** 'Tessera ledger'. */
  name: string
  /** Without dots: ['tessera']. */
  extensions: string[]
}

export interface FileDialogOptions extends DialogTarget {
  title?: string
  /** A folder, or a file path to suggest. */
  defaultPath?: string
  filters?: FileFilter[]
  /** The confirm button's label. */
  buttonLabel?: string
}

/** The `shell.files` service. */
export interface ShellFiles {
  /** Resolves the chosen file's path, or undefined if cancelled. */
  showOpenDialog(options?: FileDialogOptions): Promise<string | undefined>
  /** Resolves the chosen path, or undefined if cancelled. The platform's dialog asks before replacing a file. */
  showSaveDialog(options?: FileDialogOptions): Promise<string | undefined>
  exists(path: string): Promise<boolean>
  /** Moves a file or folder to the OS trash (Recycle Bin), where the user can restore it. Never deletes. */
  trash(path: string): Promise<void>
  /** The user's documents folder, a sensible default location. */
  documentsPath(): string
}
