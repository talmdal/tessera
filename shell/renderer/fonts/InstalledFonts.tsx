// shell/renderer/fonts/InstalledFonts.tsx — the fonts installed on this computer, for the Fonts page: asked of the main
// process the first time a page wants them (shell:fonts.families), once per window.
import { ReactNode, createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { TesseraBridge } from '@tessera/types'
import { FONTS_FAMILIES, type InstalledFonts } from '../../../shared/fonts/types'

export interface InstalledFontsSource {
  families(): Promise<InstalledFonts>
}

/** The source the app uses: the main process, which lists them once per session. */
export function createIpcFontSource(bridge: Pick<TesseraBridge, 'invoke'>): InstalledFontsSource {
  return { families: () => bridge.invoke<InstalledFonts>(FONTS_FAMILIES) }
}

const UNAVAILABLE: InstalledFonts = { families: [], complete: false }

const InstalledFontsContext = createContext<(() => Promise<InstalledFonts>) | null>(null)

/** Provides the installed fonts to the pages below it, asked for once, when a page first wants them. */
export function InstalledFontsProvider({ source, children }: { source: InstalledFontsSource, children: ReactNode }) {
  const load = useMemo(() => {
    let answer: Promise<InstalledFonts> | undefined
    return () => answer ??= source.families().then(
      fonts => fonts && Array.isArray(fonts.families) ? fonts : UNAVAILABLE,
      err => { console.error('[fonts] Could not list the installed fonts', err); return UNAVAILABLE })
  }, [source])
  return <InstalledFontsContext.Provider value={load}>{children}</InstalledFontsContext.Provider>
}

/**
 * The installed fonts, and whether they are still being listed. Outside a provider, or when they can't be listed, an
 * empty list that isn't complete: the page then offers typing a name, and never says a font isn't installed.
 */
export function useInstalledFonts(): InstalledFonts & { loading: boolean } {
  const load = useContext(InstalledFontsContext)
  const [fonts, setFonts] = useState<InstalledFonts | undefined>()
  useEffect(() => {
    if (!load) return
    let live = true
    load().then(answer => { if (live) setFonts(answer) })
    return () => { live = false }
  }, [load])
  return { ...(fonts ?? UNAVAILABLE), loading: load !== null && fonts === undefined }
}
