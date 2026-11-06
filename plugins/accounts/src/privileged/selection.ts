// What the navigator has selected. Menu clicks pass no arguments, so commands act on this; it is published as
// context keys so menu items grey out to match.
import type { PluginContext } from '@tessera/types'
import { ACCOUNTS_CONTEXT_KEYS, ACCOUNTS_EVENTS, ACCOUNTS_PLUGIN_ID, type Selection } from '@tessera/accounts-api'
import type { LedgerSession } from '@tessera/ledger-api'
import type { AccountsServiceImpl } from './AccountsServiceImpl'

const K = ACCOUNTS_CONTEXT_KEYS
const LEDGER: Selection = { kind: 'ledger' }

/** `events.emit` adds the plugin's prefix itself. */
export const local = (event: string) => event.slice(`${ACCOUNTS_PLUGIN_ID}:`.length)

export function isSelection(value: unknown): value is Selection {
  const v = value as { kind?: unknown, id?: unknown } | null
  if (v?.kind === 'ledger') return true
  return (v?.kind === 'subLedger' || v?.kind === 'account') && typeof v.id === 'string' && v.id !== ''
}

export class SelectionState {
  private current: Selection = LEDGER

  constructor(
    private readonly context: Pick<PluginContext, 'contextKeys' | 'events'>,
    private readonly accounts: AccountsServiceImpl,
    private readonly session: LedgerSession
  ) {}

  get(): Selection {
    return { ...this.current }
  }

  /** Selects something, checking it still exists; anything gone selects the ledger. */
  async set(selection: Selection, options: { announce?: boolean } = {}): Promise<Selection> {
    this.current = await this.valid(selection)
    await this.publish()
    if (options.announce) this.context.events.emit(local(ACCOUNTS_EVENTS.selection), this.get())
    return this.get()
  }

  /** After accounts or the tree changed: the selection may be gone, or an account closed or reopened. */
  async refresh(): Promise<void> {
    const before = JSON.stringify(this.current)
    this.current = await this.valid(this.current)
    await this.publish()
    if (JSON.stringify(this.current) !== before) this.context.events.emit(local(ACCOUNTS_EVENTS.selection), this.get())
  }

  /** The sub-ledger new things go in: the selected one, or the selected account's, or null for the ledger itself. */
  async targetSubLedger(): Promise<string | null> {
    const selection = this.current
    if (selection.kind === 'subLedger') return selection.id
    if (selection.kind === 'account') return (await this.accounts.get(selection.id).catch(() => undefined))?.subLedgerId ?? null
    return null
  }

  private async valid(selection: Selection): Promise<Selection> {
    if (!this.session.current || selection.kind === 'ledger') return LEDGER
    try {
      if (selection.kind === 'account') return (await this.accounts.get(selection.id)) ? selection : LEDGER
      return (await this.session.tree()).subLedgers.some(s => s.id === selection.id) ? selection : LEDGER
    } catch {
      return LEDGER
    }
  }

  private async publish() {
    const keys = this.context.contextKeys
    const selection = this.current
    const open = this.session.current !== undefined
    keys.set(K.selectionKind, open ? selection.kind : undefined)
    keys.set(K.selectionId, selection.kind === 'ledger' ? undefined : selection.id)
    const closed = selection.kind === 'account' && (await this.accounts.get(selection.id).catch(() => undefined))?.closed === true
    keys.set(K.selectionIsClosed, closed)
  }
}
