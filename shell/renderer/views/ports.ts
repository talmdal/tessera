// shell/renderer/views/ports.ts
import type { ComponentType } from 'react'
import type { ViewDescriptor } from '../../../shared/views/types'

/** Where the renderer learns which views exist. */
export interface ViewSource {
  listViews(): Promise<ViewDescriptor[]>
}

/** Turns a view descriptor into a React component, loading plugin code as needed. */
export interface ViewLoader {
  load(view: ViewDescriptor): Promise<ComponentType>
}
