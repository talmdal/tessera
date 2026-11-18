// How the exchange views reach the main process. (The same small helpers as the accounts and recurring
// plugins': plugins can't share code, so each keeps its own copy.)
import { useEffect, useState } from 'react'
import { ACCOUNTS_CHANNELS, ACCOUNTS_COMMANDS } from '@tessera/accounts-api'

/** Runs a command, as a menu item would. Resolves with the command's result. */
export function runCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T> {
  return window.api.invoke<T>('shell:commands.execute', { id, args })
}

/**
 * A value the privileged side owns: subscribe to its change event first, then request the current value, so
 * nothing is missed in between. A change that arrives before the reply wins, since it is newer.
 */
export function useFollowed<T>(channel: string, event: string): T | undefined {
  const [state, setState] = useState<{ value: T } | undefined>()

  useEffect(() => {
    let live = true
    const stop = window.api.on<T>(event, value => { if (live) setState({ value }) })
    window.api.invoke<T>(channel).then(
      value => { if (live) setState(current => current ?? { value }) },
      err => console.error(`[exchange] Could not load ${channel}`, err))
    return () => { live = false; stop() }
  }, [channel, event])

  return state?.value
}

/**
 * Opens an account's register. The account is selected in the navigator first, as clicking it would: the
 * register command is enabled only while an account is selected, so without this it is refused.
 */
export async function openRegister(accountId: string | undefined): Promise<void> {
  if (accountId === undefined) return
  await window.api.invoke(ACCOUNTS_CHANNELS.select, { kind: 'account', id: accountId })
  await runCommand(ACCOUNTS_COMMANDS.showRegister, { id: accountId })
}
