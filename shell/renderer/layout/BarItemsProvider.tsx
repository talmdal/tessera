import { ReactNode, createContext, useContext, useEffect, useState } from 'react'
import type { BorderItemDescriptor } from '@tessera/types'
import type { TesseraBridge } from '../../../shared/ipc'
import { BAR_ITEMS_CHANGED, BAR_ITEMS_LIST_CHANNEL } from '../../../shared/layout/types'

/** Where the renderer learns which bar items exist, and whether their commands are enabled. */
export interface BarItemSource {
  listItems(): Promise<BorderItemDescriptor[]>
  /** Calls `listener` when the items change; returns a function that stops. */
  onDidChange?(listener: () => void): () => void
}

export function createIpcBarItemSource(bridge: Pick<TesseraBridge, 'invoke' | 'on'>): BarItemSource {
  return {
    listItems: () => bridge.invoke<BorderItemDescriptor[]>(BAR_ITEMS_LIST_CHANNEL),
    onDidChange: listener => bridge.on(BAR_ITEMS_CHANGED, listener)
  }
}

const BarItemsContext = createContext<BorderItemDescriptor[] | null>(null)

/** Fetches the catalogue of bar items and keeps it current, for the bars below to draw from. */
export function BarItemsProvider({ source, children }: { source: BarItemSource, children: ReactNode }) {
  const [items, setItems] = useState<BorderItemDescriptor[]>([])

  useEffect(() => {
    let live = true
    let latest = 0

    // Only the most recent request may set the list, so a slow early reply can't overwrite a newer one.
    const load = () => {
      const request = ++latest
      source.listItems().then(
        list => { if (live && request === latest) setItems(list) },
        err => console.error('[layout] Failed to list bar items', err))
    }

    load()
    const stopListening = source.onDidChange?.(load)
    return () => {
      live = false
      stopListening?.()
    }
  }, [source])

  return <BarItemsContext.Provider value={items}>{children}</BarItemsContext.Provider>
}

/** Every valid bar item, present or not. Empty until the list has been fetched. */
export function useBarItemCatalogue(): BorderItemDescriptor[] {
  const items = useContext(BarItemsContext)
  if (!items) throw new Error('Bar items must be used inside <BarItemsProvider>')
  return items
}
