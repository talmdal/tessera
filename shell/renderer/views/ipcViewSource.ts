// shell/renderer/views/ipcViewSource.ts
import type { ViewDescriptor } from '@tessera/types'
import type { TesseraBridge } from '../../../shared/ipc'
import { VIEWS_CHANGED, VIEWS_LIST_CHANNEL } from '../../../shared/views/types'
import { ViewSource } from './ports'

export function createIpcViewSource(bridge: Pick<TesseraBridge, 'invoke' | 'on'>): ViewSource {
  return {
    listViews: () => bridge.invoke<ViewDescriptor[]>(VIEWS_LIST_CHANNEL),
    onDidChange: listener => bridge.on(VIEWS_CHANGED, listener)
  }
}
