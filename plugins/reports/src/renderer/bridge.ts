// How the report views reach the main process. (The same small helpers as the budget plugin's: plugins can't share
// code.)
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** Runs a command, as a menu item would, with arguments. Resolves with the command's result. */
export function runCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T> {
  return window.api.invoke<T>('shell:commands.execute', { id, args })
}

/**
 * A value the privileged side owns: subscribe to its change event first, then request the current value, so nothing
 * is missed in between. A change that arrives before the reply wins, since it is newer.
 */
export function useFollowed<T>(channel: string, event: string): T | undefined {
  const [state, setState] = useState<{ value: T } | undefined>()

  useEffect(() => {
    let live = true
    const stop = window.api.on<T>(event, value => { if (live) setState({ value }) })
    window.api.invoke<T>(channel).then(
      value => { if (live) setState(current => current ?? { value }) },
      err => console.error(`[reports] Could not load ${channel}`, err))
    return () => { live = false; stop() }
  }, [channel, event])

  return state?.value
}

/** Listens to a push event while mounted. The latest listener is called, so it may close over current state. */
export function useEvent<T>(event: string, listener: (value: T) => void): void {
  const latest = useLatest(listener)
  useEffect(() => window.api.on<T>(event, value => latest.current(value)), [event, latest])
}

/**
 * A ref that always holds the value of the last committed render: for callbacks that stay the same object from render
 * to render yet act on current props. Updated after commit, never while rendering, which must stay pure (a render
 * React throws away would otherwise leave its values behind); events reach handlers only after the commit.
 */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value)
  useLayoutEffect(() => { ref.current = value })
  return ref
}

/**
 * Whether an element is on screen. The shell keeps a main view mounted once shown, hidden (`display: none`) while
 * another is in front, so a view can't tell from being mounted; an `IntersectionObserver` can. True where there is no
 * `IntersectionObserver` (jsdom), so a view behaves as if always shown there.
 */
export function useShown(ref: RefObject<Element | null>): boolean {
  const [shown, setShown] = useState(true)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(entries => {
      const last = entries[entries.length - 1]
      if (last) setShown(last.isIntersecting)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return shown
}
