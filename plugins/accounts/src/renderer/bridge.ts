// How the accounts views reach the main process. (The same small helpers as the ledger plugin's: plugins can't share code.)
import { useEffect, useState } from 'react'

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
      err => console.error(`[accounts] Could not load ${channel}`, err))
    return () => { live = false; stop() }
  }, [channel, event])

  return state?.value
}
