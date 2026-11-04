import { ReactNode, createContext, useMemo } from 'react'
import type { RegisteredIcon } from '@tessera/types'

/** The icons plugins registered, by id, with the URL of each file. Empty outside the shell. */
export const IconRegistryContext = createContext<ReadonlyMap<string, string>>(new Map())

/** Provided by the shell, from the list the main process sends. Plugins don't need it. */
export function IconRegistryProvider({ icons, children }: { icons: readonly RegisteredIcon[], children: ReactNode }) {
  const registry = useMemo(() => new Map(icons.map(icon => [icon.id, icon.url])), [icons])
  return <IconRegistryContext.Provider value={registry}>{children}</IconRegistryContext.Provider>
}
