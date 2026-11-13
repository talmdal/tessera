// The export.formats extension point: the file types installed file-type plugins can write. Contributions are plain
// data naming an ExportFormat service; this validates them (and the options they declare, which the Export dialog
// draws), orders them, and finds the service behind one. See docs/export-design.md, "The contract".
import type { ExtensionRegistry, Logger, ServiceRegistry } from '@tessera/types'
import { isAccountType } from '@tessera/accounts-api'
import {
  ACCOUNT_FIELDS, EXPORT_FORMATS_POINT,
  type ExportFormat, type ExportFormatContribution, type ExportFormatInfo, type ExportOptionField
} from '@tessera/export-api'

const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const OPTION_KEY = /^[A-Za-z][A-Za-z0-9_]*$/

function optionProblem(raw: unknown, formatId: string): string | undefined {
  if (typeof raw !== 'object' || raw === null) return `An option of export format "${formatId}" is not an object`
  const f = raw as Record<string, unknown>
  const key = typeof f.key === 'string' ? f.key : ''
  if (!OPTION_KEY.test(key)) return `An option of export format "${formatId}" needs a key of letters and digits`
  if (!text(f.label)) return `Option "${key}" of export format "${formatId}" needs a label`
  switch (f.kind) {
    case 'boolean':
      return typeof f.default === 'boolean' ? undefined : `Option "${key}" of export format "${formatId}" needs a true or false default`
    case 'text':
      if (typeof f.default !== 'string') return `Option "${key}" of export format "${formatId}" needs a text default`
      return f.maxLength === undefined || (Number.isInteger(f.maxLength) && (f.maxLength as number) > 0) ? undefined : `Option "${key}" of export format "${formatId}" has an invalid maxLength`
    case 'choice': {
      const options = f.options
      if (!Array.isArray(options) || options.length === 0 || options.some(o => typeof o?.value !== 'string' || !text(o?.label))) {
        return `Option "${key}" of export format "${formatId}" needs choices, each with a value and a label`
      }
      return options.some(o => o.value === f.default) ? undefined : `Option "${key}" of export format "${formatId}" has a default that isn't one of its choices`
    }
    default:
      return `Option "${key}" of export format "${formatId}" has an unknown kind`
  }
}

function problemWith(raw: unknown, contributor: string): string | undefined {
  if (typeof raw !== 'object' || raw === null) return `An export format from "${contributor}" is not an object`
  const f = raw as Record<string, unknown>
  if (!text(f.id) || !f.id.startsWith(`${contributor}.`)) return `An export format from "${contributor}" needs an id starting with "${contributor}."`
  if (!text(f.label)) return `Export format "${f.id}" needs a label`
  if (!text(f.service)) return `Export format "${f.id}" needs a service`
  if (typeof f.extension !== 'string' || !/^[a-z0-9]+$/.test(f.extension)) return `Export format "${f.id}" needs an extension in lower case, without a dot, such as "csv"`
  if (f.accounts !== 'one' && f.accounts !== 'many') return `Export format "${f.id}" needs accounts: "one" or "many"`
  if (f.accountTypes !== undefined && (!Array.isArray(f.accountTypes) || f.accountTypes.length === 0 || !f.accountTypes.every(isAccountType))) {
    return `Export format "${f.id}" has invalid account types`
  }
  if (f.order !== undefined && (typeof f.order !== 'number' || !Number.isFinite(f.order))) return `Export format "${f.id}" has an invalid order`
  if (f.options !== undefined) {
    if (!Array.isArray(f.options)) return `Export format "${f.id}" has options that aren't a list`
    for (const option of f.options) {
      const problem = optionProblem(option, f.id)
      if (problem) return problem
    }
    const keys = f.options.map(o => (o as { key: string }).key)
    if (new Set(keys).size !== keys.length) return `Export format "${f.id}" has two options with the same key`
  }
  if (f.accountFields !== undefined) {
    const fields = f.accountFields
    if (!Array.isArray(fields) || fields.some(u => typeof u !== 'object' || u === null
      || !(ACCOUNT_FIELDS as readonly unknown[]).includes((u as { field?: unknown }).field)
      || !['required', 'recommended'].includes((u as { need?: unknown }).need as string)
      || ((u as { accountTypes?: unknown }).accountTypes !== undefined && (!Array.isArray((u as { accountTypes?: unknown[] }).accountTypes) || !(u as { accountTypes: unknown[] }).accountTypes.every(isAccountType))))) {
      return `Export format "${f.id}" has invalid account fields`
    }
  }
}

export class Formats {
  private readonly warned = new Set<string>()

  constructor(
    private readonly extensions: Pick<ExtensionRegistry, 'getContributions'>,
    private readonly services: Pick<ServiceRegistry, 'has' | 'get'>,
    private readonly log: Pick<Logger, 'warn'>
  ) {}

  private warn(problem: string) {
    if (this.warned.has(problem)) return
    this.warned.add(problem)
    this.log.warn(`[export] ${problem}`)
  }

  /** The valid contributions whose service is there, by order then label. Invalid ones are skipped with one warning each. */
  all(): ExportFormatContribution[] {
    const valid: ExportFormatContribution[] = []
    const seen = new Set<string>()
    for (const { contributor, impl } of this.extensions.getContributions(EXPORT_FORMATS_POINT)) {
      const id = (impl as { id?: unknown } | null)?.id
      const problem = problemWith(impl, contributor) ?? (seen.has(id as string) ? `Duplicate export format "${id}" ignored` : undefined)
      if (problem) { this.warn(problem); continue }
      const format = impl as ExportFormatContribution
      if (!this.service(format)) continue                  // its plugin didn't start, or doesn't provide it (yet)
      seen.add(format.id)
      valid.push(format)
    }
    return valid.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label))
  }

  /** A valid format by id. */
  get(id: string): ExportFormatContribution | undefined {
    return this.all().find(format => format.id === id)
  }

  /** The formats as the Export dialog lists them. */
  info(): ExportFormatInfo[] {
    return this.all().map(({ id, label, extension, description, accounts, accountTypes, options, accountFields }) => ({
      id, label, extension, accounts,
      ...(description && { description }),
      ...(accountTypes && { accountTypes: [...accountTypes] }),
      options: (options ?? []).map(option => structuredClone(option) as ExportOptionField),
      accountFields: (accountFields ?? []).map(use => structuredClone(use))
    }))
  }

  /** The service behind a format, or undefined when it isn't there (or isn't one). */
  service(format: ExportFormatContribution): ExportFormat | undefined {
    if (!this.services.has(format.service)) return undefined
    const service = this.services.get<ExportFormat>(format.service)
    return typeof service?.check === 'function' && typeof service?.write === 'function' ? service : undefined
  }
}
