import { ReactNode, useEffect, useState } from 'react'
import type { RegisteredIcon, TesseraBridge } from '@tessera/types'
import { ICONS_CHANGED, ICONS_LIST_CHANNEL } from '../../../shared/layout/types'
import { IconRegistryProvider } from '../../../tessera-ui/internal'

/**
 * Fetches the icons plugins have registered (ids and the URLs of their files, not the files, which are
 * loaded when an icon is first drawn) and keeps the list current for every `Icon` below.
 */
export function IconsProvider({ bridge, children }: { bridge: Pick<TesseraBridge, 'invoke' | 'on'>, children: ReactNode }) {
  const [icons, setIcons] = useState<RegisteredIcon[]>([])

  useEffect(() => {
    let live = true
    let latest = 0

    // Only the most recent request may set the list, so a slow early reply can't overwrite a newer one.
    const load = () => {
      const request = ++latest
      bridge.invoke<RegisteredIcon[]>(ICONS_LIST_CHANNEL).then(
        list => { if (live && request === latest) setIcons(list) },
        err => console.error('[icons] Failed to list the registered icons', err))
    }

    load()
    const stopListening = bridge.on(ICONS_CHANGED, load)
    return () => {
      live = false
      stopListening()
    }
  }, [bridge])

  return <IconRegistryProvider icons={icons}>{children}</IconRegistryProvider>
}
