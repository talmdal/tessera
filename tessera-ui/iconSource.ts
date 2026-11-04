// Fetching the SVG behind an icon a plugin registered. Done once per URL, the first time the icon is drawn,
// and kept for the session: an icon that is never drawn is never fetched.
import { useEffect, useState } from 'react'

/** Larger files are refused: an icon is a few hundred bytes, so this only stops a mistake or abuse. */
export const MAX_ICON_BYTES = 100_000

type Fetcher = (url: string) => Promise<Response>

const sources = new Map<string, string>()          // url → object URL, for icons that loaded
const inflight = new Map<string, Promise<string | undefined>>()
const failed = new Set<string>()

/** The loaded icon's source, if it is already there: no waiting, so drawing it again does not flicker. */
export function peekIconSource(url: string): string | undefined {
  return sources.get(url)
}

/**
 * Loads an icon's SVG once and resolves with an object URL to paint it with,
 * or undefined if it could not be loaded (not found, not SVG, too large). A
 * failure is remembered, so a missing file is not requested again and again.
 * The text is only ever used as an image, never inserted into the page.
 */
export function loadIconSource(url: string, fetcher: Fetcher = fetch): Promise<string | undefined> {
  const known = sources.get(url)
  if (known) return Promise.resolve(known)
  if (failed.has(url)) return Promise.resolve(undefined)

  let pending = inflight.get(url)
  if (!pending) {
    pending = (async () => {
      try {
        const response = await fetcher(url)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const text = await response.text()
        if (text.length > MAX_ICON_BYTES) throw new Error('the file is too large')
        if (!/<svg[\s>]/i.test(text)) throw new Error('the file is not an SVG')
        const source = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }))
        sources.set(url, source)
        return source
      } catch (err) {
        console.warn(`[icons] Could not load ${url}: ${err instanceof Error ? err.message : String(err)}`)
        failed.add(url)
        return undefined
      } finally {
        inflight.delete(url)
      }
    })()
    inflight.set(url, pending)
  }
  return pending
}

/** Forgets everything loaded. For tests. */
export function resetIconSources() {
  for (const source of sources.values()) URL.revokeObjectURL(source)
  sources.clear()
  inflight.clear()
  failed.clear()
}

/** The source of the icon at `url`, loading it on first use. Undefined while it loads, and if it can't. */
export function useIconSource(url: string | undefined): string | undefined {
  const [source, setSource] = useState(() => url === undefined ? undefined : peekIconSource(url))

  useEffect(() => {
    if (url === undefined) { setSource(undefined); return }
    const cached = peekIconSource(url)
    if (cached) { setSource(cached); return }

    setSource(undefined)
    let live = true
    loadIconSource(url).then(loaded => { if (live) setSource(loaded) })
    return () => { live = false }
  }, [url])

  return url === undefined ? undefined : source ?? peekIconSource(url)
}
