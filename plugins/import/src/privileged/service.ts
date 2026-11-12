// The import.manager service, and the File › Import… flow it shares with the menu: an import, then its summary, and
// the register of the account the user asks to review.
import type { CommandRegistry, Event, Logger, ShellPrompts } from '@tessera/types'
import { ACCOUNTS_COMMANDS } from '@tessera/accounts-api'
import {
  IMPORT_DIALOGS,
  type CategoriesDialogInput, type CategoriesDialogResult, type ImportManager, type ImportReport, type ParsedStatement,
  type SummaryDialogInput, type SummaryDialogResult
} from '@tessera/import-api'
import type { Formats } from './formats'
import type { Importer } from './run'

export class ImportFlow {
  private readonly listeners = new Set<(report: ImportReport) => void>()

  constructor(private readonly deps: {
    importer: Importer
    formats: Formats
    prompts: Pick<ShellPrompts, 'show'>
    commands: Pick<CommandRegistry, 'execute' | 'has'>
    log: Pick<Logger, 'error'>
  }) {}

  readonly onDidImport: Event<ImportReport> = listener => {
    this.listeners.add(listener)
    return { dispose: () => { this.listeners.delete(listener) } }
  }

  private announce(report: ImportReport) {
    for (const listener of [...this.listeners]) {
      try { listener(report) } catch (err) { this.deps.log.error('[import] An import listener failed', err) }
    }
  }

  /** Imports files (asking for them when `paths` is omitted), then shows the summary. */
  async importFiles(paths?: string[]): Promise<ImportReport | undefined> {
    const report = await this.deps.importer.importFiles(paths)
    if (!report) return undefined
    this.announce(report)
    if (report.results.length > 0 || (report.notices?.length ?? 0) > 0) {
      const answer = await this.deps.prompts.show<SummaryDialogResult, SummaryDialogInput>(IMPORT_DIALOGS.summary, report)
      if (answer?.review && this.deps.commands.has(ACCOUNTS_COMMANDS.openRegister)) {
        await this.deps.commands.execute(ACCOUNTS_COMMANDS.openRegister, { id: answer.review }).catch(err =>
          this.deps.log.error('[import] Could not show the register', err))
      }
      if (answer?.changeCategories !== undefined) await this.changeCategories(report, answer.changeCategories)
    }
    return report
  }

  /** The summary's Change… beside a statement's categories: the same question, answered again, for the next import. */
  private async changeCategories(report: ImportReport, index: number) {
    const result = report.results[index]
    const categories = result?.categories
    if (!categories) return
    const input: CategoriesDialogInput = {
      fileName: result.source, sourceLabel: categories.sourceLabel, accountName: result.accountName ?? '',
      offered: categories.offered, differing: categories.differing, examples: categories.examples, current: categories.source
    }
    const answer = await this.deps.prompts.show<CategoriesDialogResult, CategoriesDialogInput>(IMPORT_DIALOGS.categories, input)
    if (!answer || (answer.source !== 'file' && answer.source !== 'payee')) return
    await this.deps.importer.changeCategoryChoice(categories.key, answer.source, categories.sourceLabel, answer.remember === true)
      .catch(err => this.deps.log.error('[import] Could not keep the answer about the file’s categories', err))
  }

  async importStatements(statements: ParsedStatement[], source: Parameters<ImportManager['importStatements']>[1], options?: { interactive?: boolean }): Promise<ImportReport> {
    const report = await this.deps.importer.importStatements(statements, source, options)
    this.announce(report)
    return report
  }

  /** Exactly the `ImportManager` contract. */
  service(): ImportManager {
    return {
      formats: () => this.deps.formats.info(),
      importFiles: paths => this.importFiles(paths),
      importStatements: (statements, source, options) => this.importStatements(statements, source, options),
      onDidImport: this.onDidImport
    }
  }
}
