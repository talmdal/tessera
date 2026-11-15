// shell/renderer/options/builtIns.ts
import type { ComponentType } from 'react'
import type { OptionsPageProps } from '@tessera/types'
import { AppearancePage } from './AppearancePage'

export type OptionsPageComponent = ComponentType<OptionsPageProps<never>>

/**
 * The shell's own option pages, keyed by the module its descriptors name. The shell is not a federation remote,
 * so its pages are built in, exactly as its dialogs are (dialogs/builtIns.ts).
 */
export const BUILT_IN_OPTION_PAGES: Readonly<Record<string, OptionsPageComponent>> = {
  './AppearancePage': AppearancePage as OptionsPageComponent
}
