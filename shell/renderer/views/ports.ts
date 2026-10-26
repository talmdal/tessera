// shell/renderer/views/ports.ts
import type { ViewDescriptor } from '@tessera/types'
import type { ComponentType } from 'react'
/** Where the renderer learns which views exist. */
export interface ViewSource {
  listViews(): Promise<ViewDescriptor[]>
  /** Calls `listener` when the set of views changes; returns a function that stops. */
  onDidChange?(listener: () => void): () => void
}

/** Turns a view descriptor into a React component, loading plugin code as needed. */
export interface ViewLoader {
  load(view: ViewDescriptor): Promise<ComponentType>
}
