// Saved Import Choices: everything imports remember, in one place, to see, change and forget. It is all in the
// ledger's import collections already: saved account matches (`links`), payee names learnt from the bank's text
// (`aliases`), and what each source's files taught (`memory`): a format's own values, which it describes
// (`ImportFormat.describeMemory`), and the import manager's category choices and sign records, described here.
// See docs/import-formats-design.md, "Phase F6: remembered choices".
import type { Database, Logger } from '@tessera/types'
import type { AccountsService } from '@tessera/accounts-api'
import {
  ImportError,
  type AccountLinkView, type LinkUpdateRequest, type PayeeAliasView, type RememberedChoice, type RememberedDescription,
  type RememberedUpdateRequest, type SavedLinks
} from '@tessera/import-api'
import { OWN_MEMORY, type CategoryChoice } from './categoryChoice'
import type { Formats } from './formats'
import type { SignRecord } from './signRecords'
import { collectionsOf } from './store'

export interface SavedChoicesDeps {
  db: () => Database
  accounts: AccountsService
  formats: Formats
  log: Pick<Logger, 'warn'>
}

const notFound = (what: string) => new ImportError('NOT_FOUND', `That ${what} is no longer saved.`)
const percent = (share: number) => `${Math.round(share * 100)}%`

export class SavedChoices {
  constructor(private readonly deps: SavedChoicesDeps) {}

  private get c() { return collectionsOf(this.deps.db()) }

  // ---- Saved account matches ----

  async links(): Promise<SavedLinks> {
    const [links, chart] = await Promise.all([this.c.links.find(), this.deps.accounts.chart({ includeClosed: true })])
    const byId = new Map(chart.accounts.map(s => [s.account.id, s.account]))
    const formats = new Map(this.deps.formats.all().map(f => [f.id, f.label]))
    const views: AccountLinkView[] = links
      .filter(link => byId.has(link.accountId))
      .map(link => ({
        ...link, id: link.id, rev: link.rev, accountName: byId.get(link.accountId)!.name,
        ...(formats.has(link.formatId) && { formatLabel: formats.get(link.formatId)! })
      }) as AccountLinkView)
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt) || a.label.localeCompare(b.label))
    const accounts = chart.accounts.filter(s => !s.account.closed).map(({ account }) => ({ id: account.id, name: account.name, currency: account.currency }))
    return { links: views, accounts }
  }

  async updateLink(request: LinkUpdateRequest): Promise<void> {
    const link = await this.c.links.findOne({ id: request.id })
    if (!link) throw notFound('account match')
    const next = { ...link }
    if (request.accountId !== undefined) {
      const account = await this.deps.accounts.get(request.accountId)
      if (!account || account.closed) throw new ImportError('REFUSED', 'Choose an open account.')
      next.accountId = account.id
    }
    if (request.autoApply !== undefined) next.autoApply = request.autoApply
    await this.c.links.replace(next)
  }

  async forgetLink(id: string): Promise<void> {
    if (!await this.c.links.findOne({ id })) throw notFound('account match')
    await this.c.links.deleteOne({ id })
  }

  // ---- Payee names ----

  async aliases(): Promise<PayeeAliasView[]> {
    return (await this.c.aliases.find())
      .map(a => ({ id: a.id, bankText: a.pattern, payeeName: a.payeeName, uses: a.uses, createdAt: a.createdAt }))
      .sort((a, b) => a.payeeName.localeCompare(b.payeeName) || a.bankText.localeCompare(b.bankText))
  }

  async forgetAlias(id: string): Promise<void> {
    if (!await this.c.aliases.findOne({ id })) throw notFound('payee name')
    await this.c.aliases.deleteOne({ id })
  }

  // ---- What each source's files taught ----

  async remembered(): Promise<RememberedChoice[]> {
    const [records, links, chart] = await Promise.all([this.c.memory.find(), this.c.links.find(), this.deps.accounts.chart({ includeClosed: true })])
    const sourceName = (key: string) => links.find(l => l.key === key)?.label ?? key
    const accountName = (id: string) => chart.accounts.find(s => s.account.id === id)?.account.name
    const formats = this.deps.formats.all()
    const choices: RememberedChoice[] = []
    for (const record of records) {
      let described: (RememberedDescription & { categories?: RememberedChoice['categories'] }) | undefined
      let owner = 'Import'
      if (record.formatId === OWN_MEMORY) described = describeOwn(record.key, record.value, sourceName, accountName)
      else {
        const format = formats.find(f => f.id === record.formatId)
        const service = format ? this.deps.formats.service(format) : undefined
        if (!format || typeof service?.describeMemory !== 'function') continue
        try {
          described = service.describeMemory(record.key, record.value)
        } catch (err) {
          this.deps.log.warn(`[import] ${format.label} couldn't describe what it remembers: ${(err as Error)?.message ?? err}`)
        }
        owner = format.label
      }
      if (!described || typeof described.what !== 'string' || typeof described.source !== 'string') continue
      choices.push({
        id: record.id, what: described.what, source: described.source, owner,
        ...(typeof described.detail === 'string' && described.detail !== '' && { detail: described.detail }),
        ...(described.categories && { categories: described.categories })
      })
    }
    // By source, so everything about one source is together: the format's first, then the import manager's
    const ownerRank = (owner: string) => owner === 'Import' ? 1 : 0
    return choices.sort((a, b) => a.source.localeCompare(b.source, undefined, { sensitivity: 'base' }) ||
      ownerRank(a.owner) - ownerRank(b.owner) || a.what.localeCompare(b.what))
  }

  async forgetRemembered(id: string): Promise<void> {
    if (!await this.c.memory.findOne({ id })) throw notFound('choice')
    await this.c.memory.deleteOne({ id })
  }

  async updateRemembered(request: RememberedUpdateRequest): Promise<void> {
    const record = await this.c.memory.findOne({ id: request.id })
    if (!record || record.formatId !== OWN_MEMORY || !record.key.startsWith('categories:')) throw notFound('category choice')
    if (request.categories !== 'file' && request.categories !== 'payee') throw new ImportError('REFUSED', 'Choose the file\'s categories or your usual ones.')
    await this.c.memory.replace({ ...record, value: { ...(record.value as CategoryChoice), source: request.categories } })
  }
}

/** The import manager's own records, described: a source's category choice, and its sign records. */
export function describeOwn(
  key: string, value: unknown, sourceName: (key: string) => string, accountName: (id: string) => string | undefined
): (RememberedDescription & { categories?: 'file' | 'payee' }) | undefined {
  if (key.startsWith('categories:')) {
    const choice = value as Partial<CategoryChoice> | undefined
    if (choice?.source !== 'file' && choice?.source !== 'payee') return undefined
    const source = choice.label || sourceName(key.slice('categories:'.length))
    return {
      what: 'Categories from the file', source, categories: choice.source,
      detail: choice.source === 'file' ? 'The file\'s categories are used' : 'Your usual category for each payee is used'
    }
  }
  if (key.startsWith('signs:')) {
    const record = value as Partial<SignRecord> | undefined
    if (typeof record?.reverse !== 'boolean' || typeof record.outShare !== 'number') return undefined
    const rest = key.slice('signs:'.length)
    const cut = rest.lastIndexOf(':')
    const account = accountName(rest.slice(cut + 1))
    const into = account ? ` into “${account}”` : ''
    const source = sourceName(rest.slice(0, cut))
    return record.reverse
      ? { what: 'Amounts reversed', source, detail: `Files from it are read the other way round${into}` }
      : { what: 'How its amounts usually run', source, detail: `${percent(record.outShare)} money out, over ${record.lines} ${record.lines === 1 ? 'line' : 'lines'}${into}: for the sign check` }
  }
  return undefined
}

