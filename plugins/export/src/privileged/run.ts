// An export, from the Export dialog to the file: what the dialog starts from (the formats, the accounts, the one the
// user is looking at, the choices remembered), the checks it asks for as the user changes things, then the Save dialog,
// the data read again, the format's check and write, and the file saved safely. One export runs at a time, and it is
// the ledger's long operation for the whole run, so no import, backup, archive or Close Ledger changes what is read.
// Nothing in the ledger changes: it may be read-only, an archive file even. See docs/export-design.md, "The export flow".
import path from 'node:path'
import type { ContextKeyService, Logger, PluginState, ShellFiles, ShellPrompts } from '@tessera/types'
import { isLedgerError, type LedgerSession } from '@tessera/ledger-api'
import { ACCOUNT_TYPE_LABELS, ACCOUNTS_CONTEXT_KEYS, todayIso, type AccountsService } from '@tessera/accounts-api'
import {
  ACCOUNT_FIELDS, EXPORT_CONTEXT_KEYS, EXPORT_DIALOGS, EXPORT_LIMITS, EXPORT_OPERATION, EXPORT_STATE_KEYS, ExportError, RANGE_CHOICES,
  fieldApplies, optionProblems, resolveOptions, safeFileName,
  type AccountValues, type ExportData,
  type CheckResponse, type ExportAccount, type ExportDialogInput, type ExportDialogResult, type ExportFormatContribution, type ExportOptions,
  type ExportRange, type ExportRequest, type RangeState, type RememberedOptions
} from '@tessera/export-api'
import { nodeDisk, saveFile, type ExportDisk, type SaveOptions } from './files'
import type { Formats } from './formats'
import { gather, type Gathered } from './gather'
import { listNames } from '../shared/notes'

export interface ExporterDeps {
  session: LedgerSession
  accounts: AccountsService
  files: ShellFiles
  prompts: ShellPrompts
  /** What exports remember between runs: `context.state`. */
  state: PluginState
  formats: Formats
  contextKeys: Pick<ContextKeyService, 'set' | 'get'>
  log: Logger
  disk?: ExportDisk
  save?: SaveOptions
  now?: () => Date
  writeTimeoutMs?: number
}

/** What an export did, for the message after it. */
export interface ExportReport {
  path: string
  transactions: number
  accounts: number
  /** The name of the one account exported, when there was one. */
  accountName?: string
  range: ExportRange
  archived: { account: string, from: string }[]
  warnings: string[]
}

const DEFAULT_RANGE: RangeState = { choice: 'all' }

/** A range remembered before, if it is still one the dialog offers. */
function rangeStateOf(value: unknown): RangeState {
  const v = value as Partial<RangeState> | undefined
  if (!v || !(RANGE_CHOICES as readonly string[]).includes(v.choice as string)) return DEFAULT_RANGE
  return { choice: v.choice!, ...(typeof v.from === 'string' && { from: v.from }), ...(typeof v.to === 'string' && { to: v.to }) }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Account fields typed in the dialog, as far as they are text for a field a format can write. */
function accountValuesOf(value: Record<string, unknown>): AccountValues {
  const values: AccountValues = {}
  for (const [accountId, fields] of Object.entries(value)) {
    if (!isRecord(fields)) continue
    const kept = Object.fromEntries(ACCOUNT_FIELDS.filter(f => typeof fields[f] === 'string').map(f => [f, fields[f] as string]))
    if (Object.keys(kept).length > 0) values[accountId] = kept
  }
  return values
}

/**
 * The data with the account fields typed in the dialog in place of the accounts' own, for the fields the format writes:
 * for this export only. The data read from the ledger is left as it is (it is kept for the dialog's next check).
 */
function withAccountValues(data: ExportData, format: ExportFormatContribution, values: AccountValues | undefined): ExportData {
  if (!values || !format.accountFields?.length) return data
  return {
    ...data,
    accounts: data.accounts.map(account => {
      const typed = values[account.id]
      if (!typed) return account
      const next: ExportAccount = { ...account }
      for (const use of format.accountFields!) {
        const value = typed[use.field]
        if (value === undefined || !fieldApplies(use, account.type)) continue
        if (value.trim() === '') delete next[use.field]
        else next[use.field] = value.trim()
      }
      return next
    })
  }
}

/** A format's options as remembered, if they were. */
function rememberedOptions(kept: unknown, formatId: string): Record<string, unknown> | undefined {
  if (!Array.isArray(kept)) return undefined
  const found = kept.find(r => isRecord(r) && r.formatId === formatId) as RememberedOptions | undefined
  return isRecord(found?.options) ? found.options : undefined
}

/** The dialog's answer, or a preview's request, if it is one: it crossed from the renderer. */
export function requestOf(value: unknown): ExportDialogResult | undefined {
  if (!isRecord(value) || typeof value.formatId !== 'string' || !Array.isArray(value.accountIds) || !value.accountIds.every(id => typeof id === 'string')) return undefined
  const range = isRecord(value.range) ? value.range : {}
  return {
    formatId: value.formatId, accountIds: value.accountIds as string[],
    range: { ...(typeof range.from === 'string' && { from: range.from }), ...(typeof range.to === 'string' && { to: range.to }) },
    options: isRecord(value.options) ? value.options as ExportOptions : {},
    ...(isRecord(value.accountValues) && { accountValues: accountValuesOf(value.accountValues) }),
    rangeState: rangeStateOf(value.rangeState)
  }
}

export class Exporter {
  private running = false
  /** The data the dialog's last check read, by what it asked for: checks as the user changes options don't read again. */
  private cached?: { key: string, gathered: Promise<Gathered> }
  private readonly disk: ExportDisk
  private readonly now: () => Date

  constructor(private readonly deps: ExporterDeps) {
    this.disk = deps.disk ?? nodeDisk
    this.now = deps.now ?? (() => new Date())
  }

  get isRunning(): boolean {
    return this.running
  }

  /** Runs `work` as the one export in progress, and as the ledger's long operation, with a ledger open. */
  private async exclusively<T>(work: () => Promise<T>): Promise<T> {
    if (!this.deps.session.current) throw new ExportError('NO_LEDGER', 'Open a ledger to export from.')
    if (this.running) throw new ExportError('BUSY', 'Another export is running. Wait for it to finish.')
    let operation: { dispose(): void }
    try {
      operation = this.deps.session.beginOperation(EXPORT_OPERATION)
    } catch (err) {
      if (isLedgerError(err) && err.code === 'BUSY') throw new ExportError('BUSY', err.message)
      throw err
    }
    this.running = true
    this.deps.contextKeys.set(EXPORT_CONTEXT_KEYS.isRunning, true)
    try {
      return await work()
    } finally {
      this.cached = undefined
      operation.dispose()
      this.running = false
      this.deps.contextKeys.set(EXPORT_CONTEXT_KEYS.isRunning, false)
    }
  }

  /** The account the user is looking at: the register's, else the navigator's selected account. */
  private preselected(): string | undefined {
    const keys = this.deps.contextKeys
    const register = keys.get(ACCOUNTS_CONTEXT_KEYS.registerAccount)
    if (typeof register === 'string') return register
    const selected = keys.get(ACCOUNTS_CONTEXT_KEYS.selectionId)
    return keys.get(ACCOUNTS_CONTEXT_KEYS.selectionKind) === 'account' && typeof selected === 'string' ? selected : undefined
  }

  /**
   * What the Export dialog starts from. `startId`: the account *Export Account…* is for, which must be in the ledger;
   * otherwise the one the user is looking at, if any.
   */
  async dialogInput(startId?: string): Promise<ExportDialogInput> {
    const { accounts, state, formats } = this.deps
    const infos = formats.info()
    if (infos.length === 0) throw new ExportError('NO_FORMAT', 'No file type can be exported: no plugin that writes one is installed.')
    const [chart, all] = await Promise.all([accounts.chart({ includeClosed: true }), accounts.list({ includeClosed: true })])
    if (all.length === 0) throw new ExportError('INVALID', 'This ledger has no accounts to export.')
    const subLedgers = new Map(chart.subLedgers.map(s => [s.id, s]))
    const locationOf = (id: string | null): string => {
      const names: string[] = []
      for (let at = id; at !== null && names.length <= subLedgers.size;) {
        const sub = subLedgers.get(at)
        if (!sub) break
        names.unshift(sub.name)
        at = sub.parentId
      }
      return names.join(' › ')
    }
    const [lastFormat, remembered, range] = await Promise.all([
      state.get<string>(EXPORT_STATE_KEYS.lastFormat).catch(() => undefined),
      state.get<RememberedOptions[]>(EXPORT_STATE_KEYS.options).catch(() => undefined),
      state.get<RangeState>(EXPORT_STATE_KEYS.range).catch(() => undefined)
    ])
    if (startId !== undefined && !all.some(a => a.id === startId)) throw new ExportError('INVALID', 'That account isn’t in this ledger.')
    const looking = startId ?? this.preselected()
    const start = all.find(a => a.id === looking)
    // The last format used, if it can hold the account the dialog starts from; else the first that can
    const holds = (format: typeof infos[number]) => !start || !format.accountTypes || format.accountTypes.includes(start.type)
    const last = infos.find(f => f.id === lastFormat)
    const formatId = (last && holds(last) ? last : infos.find(holds) ?? last ?? infos[0]).id
    if (startId !== undefined && !infos.some(holds)) {
      throw new ExportError('INVALID', `No file type Tessera can export holds ${ACCOUNT_TYPE_LABELS[start!.type].toLowerCase()} accounts, such as “${start!.name}”.`)
    }
    return {
      ledgerName: chart.ledger.name,
      formats: infos,
      accounts: all.map(a => ({
        id: a.id, name: a.name, type: a.type, typeLabel: ACCOUNT_TYPE_LABELS[a.type], currency: a.currency, closed: a.closed,
        location: locationOf(a.subLedgerId),
        // What a format may write, to start its fields from (the dialog shows them only for a format that writes them)
        ...(a.accountNumber !== undefined && { accountNumber: a.accountNumber }),
        ...(a.bankId !== undefined && { bankId: a.bankId }),
        ...(a.intuitBankId !== undefined && { intuitBankId: a.intuitBankId })
      })),
      ...(start !== undefined && { preselectedId: start.id }),
      formatId,
      options: Object.fromEntries(infos.map(f => [f.id, resolveOptions(f.options, rememberedOptions(remembered, f.id))])),
      range: rangeStateOf(range),
      today: todayIso(this.now())
    }
  }

  private format(formatId: string): ExportFormatContribution {
    const format = this.deps.formats.get(formatId)
    if (!format) throw new ExportError('NO_FORMAT', 'That file type can’t be exported now: its plugin isn’t running.')
    return format
  }

  private read(request: Pick<ExportRequest, 'accountIds' | 'range'>, fresh: boolean): Promise<Gathered> {
    const key = JSON.stringify([[...request.accountIds].sort(), request.range.from ?? null, request.range.to ?? null])
    if (!fresh && this.cached?.key === key) return this.cached.gathered
    const gathered = gather(this.deps.accounts, request, this.now)
    this.cached = { key, gathered }
    gathered.catch(() => { if (this.cached?.gathered === gathered) this.cached = undefined })
    return gathered
  }

  /** What exporting `request` would do: the Export dialog's preview, and the check before writing. */
  async check(request: ExportRequest, fresh = false): Promise<CheckResponse & { gathered: Gathered, inFile: ExportAccount[], leftOutNote: string[], options: ExportOptions }> {
    if (!this.deps.session.current) throw new ExportError('NO_LEDGER', 'Open a ledger to export from.')
    const format = this.format(request.formatId)
    const service = this.deps.formats.service(format)!
    const options = resolveOptions(format.options, request.options)
    const read = await this.read(request, fresh)
    // The account fields typed in the dialog stand in for the accounts' own, for this export only
    const data = withAccountValues(read.data, format, request.accountValues)
    const gathered: Gathered = { ...read, data }
    // What the manager knows without the format: how many accounts a file holds, and of which types
    const problems: string[] = []
    if (format.accounts === 'one' && data.accounts.length > 1) problems.push('Choose one account: this file type holds one account per file.')
    for (const account of data.accounts) {
      if (format.accountTypes && !format.accountTypes.includes(account.type)) {
        problems.push(`This file type can’t hold ${ACCOUNT_TYPE_LABELS[account.type].toLowerCase()} accounts, such as “${account.name}”.`)
      }
    }
    problems.push(...optionProblems(format.options, options))
    const checked = await service.check(data, options, format.id)
    // What the file will hold: the accounts the format keeps. Those it leaves out are named, and counted nowhere
    const leftOut = new Set(Array.isArray(checked.accountsLeftOut) ? checked.accountsLeftOut : [])
    const inFile = data.accounts.filter(a => !leftOut.has(a.id))
    const out = data.accounts.filter(a => leftOut.has(a.id)).map(a => a.name)
    const leftOutNote = out.length > 0 && inFile.length > 0
      ? [`${listNames(out)} ${out.length === 1 ? 'has' : 'have'} no transactions in these dates, so ${out.length === 1 ? 'it isn’t' : 'they aren’t'} in the file.`]
      : []
    return {
      transactions: checked.transactions,
      // A problem the manager and the format both find is said once
      problems: [...new Set([...problems, ...checked.problems])],
      warnings: [...leftOutNote, ...checked.warnings],
      leftOutNote,
      accounts: inFile.length,
      range: data.range,
      archived: gathered.archived.filter(a => inFile.some(i => i.name === a.account)),
      gathered,
      inFile,
      options
    }
  }

  /** `check` for the dialog: the answer, without the data behind it. */
  async preview(request: ExportRequest): Promise<CheckResponse> {
    const { gathered: _gathered, inFile: _inFile, leftOutNote: _leftOutNote, options: _options, ...response } = await this.check(request)
    return response
  }

  /**
   * File › Export…, and Accounts › Export Account… (`startId`, the account it is for): the dialog, the Save dialog, the
   * file. Undefined when the user cancels either dialog.
   */
  async exportFile(startId?: string): Promise<ExportReport | undefined> {
    return this.exclusively(async () => {
      const input = await this.dialogInput(startId)
      const shown = startId !== undefined
        ? this.deps.prompts.show<ExportDialogResult, ExportDialogInput>(EXPORT_DIALOGS.export, input, { title: 'Export Account' })
        : this.deps.prompts.show<ExportDialogResult, ExportDialogInput>(EXPORT_DIALOGS.export, input)
      const request = requestOf(await shown)
      if (!request) return undefined
      const format = this.format(request.formatId)

      // Where: the last folder used (or Documents), and a name from what is exported and the dates
      const preview = await this.check(request)
      if (preview.problems.length > 0) throw new ExportError('INVALID', preview.problems.join(' '))
      const only = preview.inFile.length === 1 ? preview.inFile[0].name : undefined
      const name = safeFileName(`${only ?? preview.gathered.data.ledger.name} ${preview.range.from} to ${preview.range.to}`) + `.${format.extension}`
      const last = await this.deps.state.get<string>(EXPORT_STATE_KEYS.lastFolder).catch(() => undefined)
      const folder = last && await this.deps.files.exists(last).catch(() => false) ? last : this.deps.files.documentsPath()
      const target = await this.deps.files.showSaveDialog({
        title: 'Export', buttonLabel: 'Export', defaultPath: path.join(folder, name),
        filters: [{ name: format.label, extensions: [format.extension] }]
      })
      if (!target) return undefined

      // Read again, now the file is chosen, and check once more: the write is of what the ledger holds now
      const checked = await this.check(request, true)
      if (checked.problems.length > 0) throw new ExportError('INVALID', checked.problems.join(' '))
      const service = this.deps.formats.service(format)!
      const output = await this.within(Promise.resolve(service.write(checked.gathered.data, checked.options, format.id)), format.label)
      // (Checked by shape: bytes made in another realm, as a test's TextEncoder gives them, aren't `instanceof` this one's)
      if (!ArrayBuffer.isView(output?.bytes)) throw new ExportError('WRITE_FAILED', `The ${format.label} couldn’t be written: its plugin gave no file.`)
      await saveFile(this.disk, target, output.bytes, this.deps.save)

      await this.remember(request, format, checked.options, path.dirname(target))
      const { data } = checked.gathered
      this.deps.log.info(`[export] Exported ${checked.transactions} transactions from ${checked.accounts} accounts as ${format.id}`)
      return {
        path: target, transactions: checked.transactions, accounts: checked.accounts,
        ...(checked.inFile.length === 1 && { accountName: checked.inFile[0].name }),
        range: data.range, archived: checked.archived,
        // The accounts left out, then what the format said as it wrote
        warnings: [...checked.leftOutNote, ...(output.warnings ?? [])]
      }
    })
  }

  /** A format's write, with a time limit: a writer that hangs fails the export rather than holding the ledger. */
  private within<T>(work: Promise<T>, label: string): Promise<T> {
    const limit = this.deps.writeTimeoutMs ?? EXPORT_LIMITS.writeTimeoutMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ExportError('WRITE_FAILED', `The ${label} took too long to write (more than ${limit / 1000} seconds).`)), limit)
    })
    return Promise.race([work, expired]).finally(() => clearTimeout(timer))
  }

  /** What the next export starts from: this format, its options, these dates, this folder. */
  private async remember(request: ExportDialogResult, format: ExportFormatContribution, options: ExportOptions, folder: string) {
    const { state, log } = this.deps
    try {
      const kept = await state.get<RememberedOptions[]>(EXPORT_STATE_KEYS.options).catch(() => undefined)
      const others = (Array.isArray(kept) ? kept : []).filter(r => isRecord(r) && r.formatId !== format.id)
      await state.set<RememberedOptions[]>(EXPORT_STATE_KEYS.options, [...others, { formatId: format.id, options }])
      await state.set(EXPORT_STATE_KEYS.lastFormat, format.id)
      await state.set(EXPORT_STATE_KEYS.range, request.rangeState)
      await state.set(EXPORT_STATE_KEYS.lastFolder, folder)
    } catch (err) {
      log.warn(`[export] Could not remember the export's choices: ${(err as Error)?.message ?? err}`)
    }
  }
}
