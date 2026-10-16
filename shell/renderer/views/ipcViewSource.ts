// shell/renderer/views/ipcViewSource.ts
import type { TesseraBridge } from '../../../shared/ipc'
import { VIEWS_LIST_CHANNEL, ViewDescriptor } from '../../../shared/views/types'
import { ViewSource } from './ports'

export function createIpcViewSource(bridge: TesseraBridge): ViewSource {
  return {
    listViews: () => bridge.invoke<ViewDescriptor[]>(VIEWS_LIST_CHANNEL)
  }
}
