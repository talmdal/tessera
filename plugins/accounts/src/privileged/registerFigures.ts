// The `accounts.register.figures` extension point: figures other plugins add above the register, beside Current,
// Cleared and Available — a projected balance, say. Contributions are plain data; the number comes from the
// command each names, which the register runs with `RegisterFigureArgs`.
import type { CommandRegistry, ExtensionRegistry, Logger } from '@tessera/types'
import {
  REGISTER_FIGURES_POINT,
  type AccountType, type RegisterFigureContribution, type ResolvedRegisterFigure
} from '@tessera/accounts-api'
import { checkCommonFields, collect, isText } from './points'

function problemWith(raw: unknown, contributor: string): string | undefined {
  const common = checkCommonFields(raw, contributor, 'register figure')
  if (common) return common
  const a = raw as Record<string, unknown>
  if (a.refreshOn !== undefined && !isText(a.refreshOn)) return `Register figure "${a.id}" has an invalid refreshOn`
  return undefined
}

export class RegisterFigures {
  private readonly warned = new Set<string>()

  constructor(
    private readonly extensions: Pick<ExtensionRegistry, 'getContributions'>,
    private readonly commands: Pick<CommandRegistry, 'isEnabled' | 'has'>,
    private readonly log: Pick<Logger, 'warn'>
  ) {}

  /** Valid contributions, by order then as contributed. Invalid ones are skipped with one warning each. */
  all(): RegisterFigureContribution[] {
    return collect<RegisterFigureContribution>(
      this.extensions, REGISTER_FIGURES_POINT, problemWith, this.log, this.warned, 'register figure')
  }

  /** The figures for an account of this type, each enabled exactly when its command is. */
  for(type: AccountType): ResolvedRegisterFigure[] {
    return this.all()
      .filter(figure => figure.accountTypes === undefined || figure.accountTypes.includes(type))
      .map(({ id, label, command, refreshOn, description }) => ({
        id, label, command, enabled: this.commands.has(command) && this.commands.isEnabled(command),
        ...(refreshOn !== undefined && { refreshOn }),
        ...(description !== undefined && { description })
      }))
  }
}
