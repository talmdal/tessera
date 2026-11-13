// The `accounts.navigator.items` extension point: rows other plugins add to the Accounts navigator, above the book
// or below the tree. Each runs a command and may carry a badge taken from a context key, so a count (overdue
// recurring transactions, say) stays live without the contributing plugin pushing anything of its own.
import type { CommandRegistry, ContextKeyService, Disposable, ExtensionRegistry, Logger } from '@tessera/types'
import {
  NAVIGATOR_ITEMS_POINT,
  type NavigatorBadgeTone, type NavigatorItemContribution, type NavigatorItemPlacement, type ResolvedNavigatorItem
} from '@tessera/accounts-api'
import { checkCommonFields, collect, isText } from './points'

const PLACEMENTS: readonly string[] = ['top', 'bottom']
const TONES: readonly string[] = ['default', 'warning', 'error']

function problemWith(raw: unknown, contributor: string): string | undefined {
  const common = checkCommonFields(raw, contributor, 'navigator item')
  if (common) return common
  const a = raw as Record<string, unknown>
  if (a.placement !== undefined && !PLACEMENTS.includes(a.placement as string)) return `Navigator item "${a.id}" needs a placement of "top" or "bottom"`
  if (a.badgeTone !== undefined && !TONES.includes(a.badgeTone as string)) return `Navigator item "${a.id}" has an invalid badgeTone`
  if (a.badgeKey !== undefined && !isText(a.badgeKey)) return `Navigator item "${a.id}" has an invalid badgeKey`
  return undefined
}

/** A context-key value worth showing as a badge: not unset, not false, not zero, not an empty string. */
export function badgeTextOf(value: unknown): string | undefined {
  if (value === undefined || value === null || value === false || value === 0 || value === '') return undefined
  if (value === true) return undefined
  return String(value)
}

export class NavigatorItems {
  private readonly warned = new Set<string>()

  constructor(
    private readonly extensions: Pick<ExtensionRegistry, 'getContributions'>,
    private readonly commands: Pick<CommandRegistry, 'isEnabled' | 'has'>,
    private readonly contextKeys: Pick<ContextKeyService, 'get' | 'onDidChange'>,
    private readonly log: Pick<Logger, 'warn'>
  ) {}

  /** Valid contributions, by order then as contributed. Invalid ones are skipped with one warning each. */
  all(): NavigatorItemContribution[] {
    return collect<NavigatorItemContribution>(
      this.extensions, NAVIGATOR_ITEMS_POINT, problemWith, this.log, this.warned, 'navigator item')
  }

  /** Every row the navigator should draw, with its command's state and its badge as they are now. */
  resolved(): ResolvedNavigatorItem[] {
    return this.all().map(({ id, label, command, icon, placement, badgeKey, badgeTone, description }) => {
      const badge = badgeKey === undefined ? undefined : badgeTextOf(this.contextKeys.get(badgeKey))
      return {
        id, label, command,
        placement: (placement ?? 'bottom') as NavigatorItemPlacement,
        badgeTone: (badgeTone ?? 'default') as NavigatorBadgeTone,
        enabled: this.commands.has(command) && this.commands.isEnabled(command),
        ...(icon !== undefined && { icon }),
        ...(description !== undefined && { description }),
        ...(badge !== undefined && { badge })
      }
    })
  }

  /** The context keys the current contributions take badges from. */
  badgeKeys(): Set<string> {
    return new Set(this.all().map(item => item.badgeKey).filter(isText))
  }

  /**
   * Calls `onChanged` whenever a contributed badge's context key changes value, so the navigator can re-read the
   * list. The set of keys is recomputed on each change, since a plugin may contribute after this is called.
   */
  watchBadges(onChanged: () => void): Disposable {
    return this.contextKeys.onDidChange((keys: string[]) => {
      const watched = this.badgeKeys()
      if (keys.some(key => watched.has(key))) onChanged()
    })
  }
}
