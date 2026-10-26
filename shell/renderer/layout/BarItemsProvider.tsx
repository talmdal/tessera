// shell/renderer/layout/BarItemsProvider.tsx
//
// The bar-item catalogue: every valid `shell.bar.items` contribution, with its
// enabled flag, resolved by the main process. Which items are *present* in a
// bar is the layout state's business; this is only how to draw them.
import { ReactNode, createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { BarItemDescriptor, TesseraBridge } from '@tessera/types'
import { BAR_ITEMS_CHANGED, BAR_ITEMS_LIST } from '../../../shared/layout/types'
/** Where the renderer learns which bar items exist. */
export interface BarItemSource {
  listItems(): Promise<BarItemDescriptor[]>
  /** Calls `listener` when the set (or enablement) of items changes; returns a function that stops. */
  onDidChange?(listener: () => void): () => void
}

export function createIpcBarItemSource(bridge: Pick<TesseraBridge, 'invoke' | 'on'>): BarItemSource {
  return {
    listItems: () => bridge.invoke<BarItemDescriptor[]>(BAR_ITEMS_LIST),
    onDidChange: listener => bridge.on(BAR_ITEMS_CHANGED, listener)
  }
}

interface BarItemsContextValue {
  byId: Map<string, BarItemDescriptor>
}

const BarItemsContext = createContext<BarItemsContextValue | null>(null)

export function BarItemsProvider({ source, children }: { source: BarItemSource, children: ReactNode }) {
  const [items, setItems] = useState<BarItemDescriptor[]>([])

  useEffect(() => {
    let live = true
    let latest = 0

    const load = () => {
      const request = ++latest
      source.listItems().then(
        list => { if (live && request === latest) setItems(list) },
        err => console.error('[layout] Failed to list bar items', err)
      )
    }

    load()
    const stopListening = source.onDidChange?.(load)
    return () => {
      live = false
      stopListening?.()
    }
  }, [source])

  const value = useMemo(() => ({ byId: new Map(items.map(item => [item.id, item])) }), [items])

  return <BarItemsContext.Provider value={value}>{children}</BarItemsContext.Provider>
}

/** Descriptors by id; an id the catalogue doesn't know yet is simply not drawn. */
export function useBarItemCatalogue(): BarItemsContextValue {
  const context = useContext(BarItemsContext)
  if (!context) throw new Error('Bar item hooks must be used inside <BarItemsProvider>')
  return context
}
