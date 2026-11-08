// shell/main/fonts/fontCatalogue.ts — the fonts installed on this computer, for the Fonts page: listed once, the first
// time they are asked for, by a port (shell/main/fonts/electronFontProbe.ts in the app), and kept for the session.
import type { Logger } from '@tessera/types'
import { isFontFamilyName } from '../../../shared/fonts/families'
import type { InstalledFonts } from '../../../shared/fonts/types'

/** Lists installed font families. Rejects when they can't be listed. */
export interface FontCataloguePort {
  listFamilies(): Promise<string[]>
}

export interface FontCatalogue {
  /** The installed families. Never rejects: when they can't be listed, an empty list that says it isn't complete. */
  families(): Promise<InstalledFonts>
}

export interface FontCatalogueOptions {
  /** How long listing may take before it counts as failed. Default 5 s. */
  timeoutMs?: number
  log?: Pick<Logger, 'warn'>
}

const UNAVAILABLE: InstalledFonts = { families: [], complete: false }

/**
 * The installed fonts, listed lazily (nothing is listed at start-up) and once per session, sorted, each name once
 * (compared without case, the first spelling kept), and only names the shell accepts as font names: one it would
 * refuse can't be chosen, so it isn't offered.
 *
 * A failure is not an error for the user: a rejection, a timeout or an empty list answers "not available", which the
 * page shows as a box to type a name in, and is logged once. An empty list counts as a failure because the platform
 * answers an empty list, not an error, when listing isn't permitted (docs/font-roles-design.md#phase-0-results).
 */
export function createFontCatalogue(port: FontCataloguePort, { timeoutMs = 5000, log }: FontCatalogueOptions = {}): FontCatalogue {
  let answer: Promise<InstalledFonts> | undefined

  async function list(): Promise<InstalledFonts> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs)
      })
      const names = await Promise.race([port.listFamilies(), timeout])
      if (!Array.isArray(names)) throw new Error('the answer was not a list')

      const byKey = new Map<string, string>()
      for (const raw of names) {
        const name = typeof raw === 'string' ? raw.trim() : ''
        if (isFontFamilyName(name) && !byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name)
      }
      if (byKey.size === 0) {
        log?.warn('[fonts] No installed fonts were listed (listing may not be permitted); fonts can still be typed by name')
        return UNAVAILABLE
      }
      return { families: [...byKey.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })), complete: true }
    } catch (err) {
      log?.warn(`[fonts] Could not list the installed fonts; fonts can still be typed by name: ${err instanceof Error ? err.message : String(err)}`)
      return UNAVAILABLE
    } finally {
      clearTimeout(timer)
    }
  }

  return { families: () => answer ??= list() }
}
