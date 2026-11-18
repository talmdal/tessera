// The `accounts.register.overlays` extension point: provisional rows another plugin lays over the register —
// a statement's downloaded transactions waiting to be read, say. A contribution is plain data; the rows come
// from the IPC channel it names, which the register invokes itself with `{ accountId }`.
import type { ExtensionRegistry, Logger } from '@tessera/types'
import {
  REGISTER_OVERLAYS_POINT,
  type RegisterOverlayContribution, type ResolvedRegisterOverlay
} from '@tessera/accounts-api'
import { collect, isText, type Validator } from './points'

const problemWith: Validator = (raw, contributor) => {
  if (typeof raw !== 'object' || raw === null) return `A register overlay from "${contributor}" is not an object`
  const a = raw as Record<string, unknown>
  if (!isText(a.id) || !(a.id as string).startsWith(`${contributor}.`)) {
    return `A register overlay from "${contributor}" needs an id starting with "${contributor}."`
  }
  if (!isText(a.channel)) return `Register overlay "${a.id}" needs the channel its rows come from`
  if (a.refreshOn !== undefined && !isText(a.refreshOn)) return `Register overlay "${a.id}" has an invalid refreshOn`
  if (a.order !== undefined && (typeof a.order !== 'number' || !Number.isFinite(a.order))) return `Register overlay "${a.id}" has an invalid order`
  return undefined
}

export class RegisterOverlays {
  private readonly warned = new Set<string>()

  constructor(
    private readonly extensions: Pick<ExtensionRegistry, 'getContributions'>,
    private readonly log: Pick<Logger, 'warn'>
  ) {}

  /** Valid contributions, by order then as contributed. Invalid ones are skipped with one warning each. */
  resolved(): ResolvedRegisterOverlay[] {
    return collect<RegisterOverlayContribution>(
      this.extensions, REGISTER_OVERLAYS_POINT, problemWith, this.log, this.warned, 'register overlay')
      .map(({ id, channel, refreshOn }) => ({ id, channel, ...(refreshOn !== undefined && { refreshOn }) }))
  }
}
