// shell/renderer/dialogs/builtIns.ts — components of the shell's own `shell.dialogs` contributions, by module.
import type { ComponentType } from 'react'
import type { DialogProps } from '@tessera/types'
import { PROMPT_DIALOG_MODULE } from '../../../shared/dialogs/types'
import { PromptDialog } from './PromptDialog'

export type DialogComponent = ComponentType<DialogProps<any, any>>

export const BUILT_IN_DIALOGS: Readonly<Record<string, DialogComponent>> = {
  [PROMPT_DIALOG_MODULE]: PromptDialog
}
