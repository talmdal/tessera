import { useRef } from 'react'

/**
 * The ids that have been `active` while `visible`, so far. A view is only
 * loaded the first time it is shown, and stays mounted (hidden) after that so
 * its state survives switching away and back.
 */
export function useEverShown(active: string | undefined, visible: boolean): ReadonlySet<string> {
  const shown = useRef(new Set<string>())
  if (visible && active !== undefined) shown.current.add(active)
  return shown.current
}
