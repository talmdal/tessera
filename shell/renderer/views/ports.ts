// shell/renderer/views/ports.ts
import type { ComponentType } from 'react'
import type { ViewDescriptor } from '../../../shared/views/types'

/** Where the renderer learns which views exist. */
export interface ViewSource {
  listViews(): Promise<ViewDescriptor[]>
  /** Calls `listener` when the set of views changes; returns a function that stops. */
  onDidChange?(listener: () => void): () => void
}

/** What names a component in a plugin's renderer remote: a view, or a dialog. */
export type RemoteModule = Pick<ViewDescriptor, 'id' | 'pluginId' | 'module' | 'remoteEntry'>

/** Turns a view (or dialog) descriptor into a React component, loading plugin code as needed. */
export interface ViewLoader {
  load(view: RemoteModule | ViewDescriptor): Promise<ComponentType<any>>
}
