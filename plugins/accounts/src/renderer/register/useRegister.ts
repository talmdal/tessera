// What the register shows, followed from the plugin: which account, its rows and balances, and the choices its
// fields offer (categories, and the accounts a transfer can go to).
import { useCallback, useEffect, useState } from 'react'
import {
  ACCOUNTS_CHANNELS, ACCOUNTS_EVENTS, type Category, type Chart, type RegisterSnapshot
} from '@tessera/accounts-api'
import { useFollowed } from '../bridge'

export interface RegisterData {
  /** undefined while loading; null when no account is chosen. */
  snapshot: RegisterSnapshot | null | undefined
  chart: Chart | null | undefined
  categories: Category[]
  reload(): void
}

export function useRegisterData(): RegisterData {
  const shown = useFollowed<{ accountId: string | null }>(ACCOUNTS_CHANNELS.registerAccount, ACCOUNTS_EVENTS.register)
  const chart = useFollowed<Chart | null>(ACCOUNTS_CHANNELS.chart, ACCOUNTS_EVENTS.chart)
  const categories = useFollowed<Category[]>(ACCOUNTS_CHANNELS.categories, ACCOUNTS_EVENTS.categories) ?? []
  const accountId = shown === undefined ? undefined : shown.accountId
  const [snapshot, setSnapshot] = useState<RegisterSnapshot | null>()
  const [version, setVersion] = useState(0)
  const reload = useCallback(() => setVersion(v => v + 1), [])

  // Another account's transactions changing doesn't matter here; this one's does
  useEffect(() => window.api.on<{ accounts: string[] }>(ACCOUNTS_EVENTS.transactions, ({ accounts }) => {
    if (accountId && accounts.includes(accountId)) reload()
  }), [accountId, reload])

  // Reload when the account changes, when asked, and when the chart changes (a rename, a close, a transfer's other side)
  useEffect(() => {
    if (accountId === undefined) return
    if (accountId === null) { setSnapshot(null); return }
    let live = true
    window.api.invoke<RegisterSnapshot | null>(ACCOUNTS_CHANNELS.loadRegister, { accountId }).then(
      loaded => { if (live) setSnapshot(loaded) },
      err => { console.error('[accounts] Could not load the register', err); if (live) setSnapshot(null) })
    return () => { live = false }
  }, [accountId, version, chart])

  return { snapshot: accountId === undefined ? undefined : snapshot, chart, categories, reload }
}
