// @vitest-environment node
// `exchange.service` end to end on a real book: reading through a fake format, resolving the account, filing
// the statement to read, matching it against the live register, accepting it row by row, and taking a whole
// statement's batch back out again.
import { describe, expect, it } from 'vitest'
import {
  accountFromStatement, resolveAccount
} from '../../../plugins/exchange/src/privileged/planning'
import { document, registerOf, rejection, row, setupExchange, statement } from './harness'

describe('reading a file', () => {
  it('chooses the format by extension, and carries the file’s name and hash', async () => {
    const { service, format } = await setupExchange()
    format.next(document())
    const read = await service.read('/in/statement.fake')

    expect(read.fileName).toBe('statement.fake')
    expect(read.fileHash).toMatch(/^[0-9a-f]{64}$/)
    expect(read.path).toBe('/in/statement.fake')
    expect(read.document.statements[0].transactions).toHaveLength(1)
  })

  it('refuses a file holding nothing, and one beyond the row limit', async () => {
    const { service, format } = await setupExchange({ options: { maxRows: 1 } })

    format.next(document({ statements: [statement({ transactions: [] })] }))
    expect((await rejection(service.read('/in/statement.fake'))).code).toBe('EMPTY')

    format.next(document({ statements: [statement({ transactions: [row(), row({ date: '2026-11-04' })] })] }))
    const tooBig = await rejection(service.read('/in/statement.fake'))
    expect(tooBig.code).toBe('TOO_LARGE')
    expect(tooBig.message).toMatch(/limit of 1/)
  })

  it('says so plainly when no format is installed', async () => {
    const { service } = await setupExchange({ withoutFormat: true })
    const failure = await rejection(service.read('/in/statement.fake'))
    expect(failure.code).toBe('UNKNOWN_FORMAT')
    expect(failure.message).toMatch(/No file formats are installed/)
  })

  it('answers a reader’s question from what the caller passed, without asking the user', async () => {
    const { service, format, prompts } = await setupExchange()
    format.asks({ kind: 'choice', id: 'dialect', title: 'Which dialect?', options: [] })
    format.next(document())

    await service.read('/in/statement.fake', { answers: { dialect: 'microsoft' } })
    expect(format.answers).toEqual(['microsoft'])
    expect(prompts.show).not.toHaveBeenCalled()
  })

  it('asks the user when nothing else can answer, and fails if they decline', async () => {
    const { service, format, prompts } = await setupExchange()
    format.asks({ kind: 'choice', id: 'dialect', title: 'Which dialect?', options: [] })
    format.next(document())

    prompts.show.mockResolvedValueOnce('standard')
    await service.read('/in/statement.fake')
    expect(format.answers).toEqual(['standard'])

    prompts.show.mockResolvedValueOnce(undefined)
    expect((await rejection(service.read('/in/statement.fake'))).code).toBe('INVALID')
  })
})

describe('resolving the account', () => {
  it('finds it by the account number, even when the file shows only the last digits', async () => {
    const { accounts, chq } = await setupExchange()
    const { target } = await resolveAccount(
      statement({ account: { number: '7890', currency: 'CAD' } }), 'fake.statements', { accounts, links: [] })
    expect(target).toEqual({ kind: 'existing', accountId: chq.id, matchedBy: 'number' })
  })

  it('falls back to the name when there is no usable number', async () => {
    const { accounts, savings } = await setupExchange()
    const { target } = await resolveAccount(
      statement({ account: { name: 'Savings', currency: 'CAD' } }), 'fake.statements', { accounts, links: [] })
    expect(target).toEqual({ kind: 'existing', accountId: savings.id, matchedBy: 'name' })
  })

  it('is unresolved when nothing identifies it, with the account dialog prefilled from the statement', async () => {
    const { accounts, today } = await setupExchange()
    const mystery = statement({
      account: { name: 'Mystery', currency: 'CAD', number: '5555' },
      balances: { ledger: { amount: -20000, asOf: '2026-11-30' } },
      transactions: [row({ amount: -5000 })]
    })
    const { target } = await resolveAccount(mystery, 'fake.statements', { accounts, links: [] })
    expect(target).toEqual({ kind: 'unresolved' })

    // The opening balance leaves the account at the bank's figure once the statement is read
    const prefill = accountFromStatement(mystery, today)
    expect(prefill).toMatchObject({ name: 'Mystery', currency: 'CAD', openingBalance: -15000, accountNumber: '5555' })
  })

  it('uses a remembered link first, so the second import of a source asks nothing', async () => {
    const { service, accounts, fileOf, savings } = await setupExchange()
    // Filing with `remember` writes the link, as the Choose Account dialog's tick box does
    await fileOf(document(), { accountId: savings.id, remember: true })
    const links = await service.links()
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ accountId: savings.id, numberKey: '1234567890', formatId: 'fake.statements' })

    const { target } = await resolveAccount(statement(), 'fake.statements', { accounts, links })
    expect(target).toEqual({ kind: 'existing', accountId: savings.id, matchedBy: 'link' })
  })
})

describe('filing a statement to read', () => {
  it('stops wholly archived statements unless overridden and confirms straddling early rows on acceptance', async () => {
    const { service, accounts, fileOf, chq } = await setupExchange()
    await accounts.updateAccount(chq.id, { openingDate: '2026-01-01' })
    const archived = document({
      statements: [statement({
        period: { from: '2025-11-01', to: '2025-11-30' },
        transactions: [row({ date: '2025-11-03', amount: -1200 })]
      })]
    })
    const refused = await rejection(fileOf(archived))
    expect(refused.code).toBe('ARCHIVED_PERIOD')
    expect((await service.pendingFor(chq.id))).toHaveLength(0)

    await fileOf(archived, { archivedOverride: true })
    const [forced] = await service.pendingFor(chq.id)
    expect(forced.rows[0].archivedPeriod).toBe(true)
    await service.dismiss(chq.id, forced.id)

    const straddling = document({
      statements: [statement({
        period: { from: '2025-12-30', to: '2026-01-03' },
        transactions: [row({ date: '2025-12-31', amount: -4200 }), row({ date: '2026-01-03', amount: -100 })]
      })]
    })
    await fileOf(straddling, { path: '/in/december.fake' })
    const [waiting] = await service.pendingFor(chq.id)
    expect(waiting.rows.map(row => row.archivedPeriod ?? false)).toEqual([true, false])
    expect((await service.pendingSummary()).find(line => line.accountId === chq.id)?.archivedItems).toBe(1)
    expect((await service.overlayRows(chq.id))[0].note).toContain('Before opening date (already archived)')

    const openingBalance = (await accounts.get(chq.id))!.openingBalance
    const balance = (await accounts.balances(chq.id)).current
    const refusedAccept = await rejection(service.accept(chq.id, waiting.id, waiting.rows[0].key))
    expect(refusedAccept).toMatchObject({ code: 'CONFIRMATION_REQUIRED', reasons: ['archivedPeriod'] })
    expect((await accounts.balances(chq.id)).current).toBe(balance)

    await service.accept(chq.id, waiting.id, waiting.rows[0].key, { confirm: ['archivedPeriod'] })
    expect(await accounts.get(chq.id)).toMatchObject({ openingDate: '2025-12-31', openingBalance })
    expect((await accounts.balances(chq.id)).current).toBe(balance - 4200)
  })

  it('stores the statement against the account, and nothing reaches the register', async () => {
    const { service, accounts, fileOf, chq } = await setupExchange()
    const result = await fileOf(document({
      statements: [statement({
        period: { from: '2026-11-01', to: '2026-11-30' },
        balances: { ledger: { amount: 480000, asOf: '2026-11-30' } },
        transactions: [row({ externalId: 'FIT-1' }), row({ date: '2026-11-05', amount: -450, payee: 'The Daily Grind', externalId: 'FIT-2' })]
      })]
    }))

    expect(result.filed).toBe(2)
    expect(result.duplicates).toBe(0)
    expect(result.statement).toMatchObject({
      accountId: chq.id,
      fileName: 'statement.fake',
      ledger: { amount: 480000, asOf: '2026-11-30' }
    })
    expect(await registerOf(accounts, chq.id)).toHaveLength(0)

    const waiting = await service.pendingFor(chq.id)
    expect(waiting).toHaveLength(1)
    expect(waiting[0].rows.map(r => r.transaction.externalId)).toEqual(['FIT-1', 'FIT-2'])
  })

  it('drops a row whose bank reference the account already holds', async () => {
    const { accounts, fileOf, chq } = await setupExchange()
    await accounts.transactions(chq.id).create({ date: '2026-11-03', amount: -14200, status: 'electronic', externalId: 'FIT-1' })

    const result = await fileOf(document({
      statements: [statement({ transactions: [row({ externalId: 'FIT-1' }), row({ date: '2026-11-05', externalId: 'FIT-2' })] })]
    }))
    expect(result.filed).toBe(1)
    expect(result.duplicates).toBe(1)
  })

  it('drops a row an earlier statement already filed, and refuses the identical file whole', async () => {
    const { service, fileOf, chq } = await setupExchange()
    await fileOf(document({ statements: [statement({ transactions: [row({ externalId: 'FIT-1' })] })] }))

    // The identical file again: caught by its hash before any row is looked at
    const again = await rejection(fileOf(document({ statements: [statement({ transactions: [row({ externalId: 'FIT-1' })] })] })))
    expect(again.code).toBe('INVALID')
    expect(again.message).toMatch(/already waiting/)

    // A new month's file repeating one reference: only the new row is filed
    const next = await fileOf(document({
      statements: [statement({ transactions: [row({ externalId: 'FIT-1' }), row({ date: '2026-12-01', externalId: 'FIT-3' })] })]
    }), { path: '/in/december.fake' })
    expect(next).toMatchObject({ filed: 1, duplicates: 1 })
    expect((await service.pendingFor(chq.id)).flatMap(s => s.rows.map(r => r.transaction.externalId))).toEqual(['FIT-1', 'FIT-3'])
  })

  it('refuses a statement in a currency the account does not use', async () => {
    const { fileOf } = await setupExchange()
    const failure = await rejection(fileOf(document({
      statements: [statement({ account: { number: '1234567890', currency: 'EUR' } })]
    })))
    expect(failure.code).toBe('CURRENCY_MISMATCH')
  })
})

describe('the register’s provisional rows', () => {
  it('proposes a new row, with the payee and category resolved, Accept and Change… on it', async () => {
    const { service, fileOf, chq, accounts } = await setupExchange()
    const category = await accounts.categories.create('Utilities : Electricity', 'expense')
    await fileOf(document({ statements: [statement({ transactions: [row({ category: 'Utilities:Electricity' })] })] }))

    const rows = await service.overlayRows(chq.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      date: '2026-11-03', amount: -14200, payee: 'Hydro Ottawa', note: 'New'
    })
    expect(rows[0].categoryLabel).toContain('Electricity')
    expect(category.id).toBeTruthy()
    expect(rows[0].actions.map(a => a.label)).toEqual(['Accept', 'Change…', 'Edit…', 'Skip'])
    expect(rows[0].actions[0]).toMatchObject({ command: 'exchange.accept', primary: true })
  })

  it('matches a row to the uncleared transaction the user typed, against the live register', async () => {
    const { service, fileOf, chq, accounts } = await setupExchange()
    const typed = await accounts.transactions(chq.id).create({ date: '2026-11-02', amount: -14200, payee: 'Hydro Ottawa', status: 'uncleared' })
    await fileOf(document({ statements: [statement({ transactions: [row({ externalId: 'FIT-1' })] })] }))

    const rows = await service.overlayRows(chq.id)
    expect(rows[0].matchedId).toBe(typed.id)
    expect(rows[0].note).toMatch(/^Matches/)
  })

  it('shows a row whose reference turned up since it was filed as already here', async () => {
    const { service, fileOf, chq, accounts } = await setupExchange()
    await fileOf(document({ statements: [statement({ transactions: [row({ externalId: 'FIT-1' })] })] }))
    await accounts.transactions(chq.id).create({ date: '2026-11-03', amount: -14200, status: 'electronic', externalId: 'FIT-1' })

    const rows = await service.overlayRows(chq.id)
    expect(rows[0].note).toMatch(/Already here/)
  })
})

describe('what a file says about itself', () => {
  it('matches a payee a standard QIF cut short against the whole name in the register', async () => {
    const { service, fileOf, accounts, chq } = await setupExchange()
    const typed = await accounts.transactions(chq.id).create({ date: '2026-11-03', amount: -5620, payee: 'Canadian Tire Store', status: 'uncleared' })
    // The file says its payees are cut at fifteen; the row's payee is exactly that long
    const doc = document({ statements: [statement({ transactions: [row({ amount: -5620, payee: 'Canadian Tire S' })] })], truncatedAt: 15 })
    await fileOf(doc)
    const rows = await service.overlayRows(chq.id)
    expect(rows[0].matchedId).toBe(typed.id)
    // Without the hint the same row is new: "Canadian Tire S" is not "Canadian Tire Store"
    const { service: other, fileOf: fileOther, accounts: otherAccounts, chq: otherChq } = await setupExchange()
    await otherAccounts.transactions(otherChq.id).create({ date: '2026-11-03', amount: -5620, payee: 'Canadian Tire Store', status: 'uncleared' })
    await fileOther(document({ statements: [statement({ transactions: [row({ amount: -5620, payee: 'Canadian Tire S' })] })] }))
    expect((await other.overlayRows(otherChq.id))[0].matchedId).toBeUndefined()
  })

  it('creates the categories a file carried, once, and resolves rows to them', async () => {
    const { service, fileOf, accounts, chq } = await setupExchange()
    // Categories the starter chart does not have, so they really are created here
    const doc = document({
      categories: [{ path: 'Hobbies : Photography', kind: 'expense' }, { path: 'Side income', kind: 'income' }, { path: 'Salary', kind: 'income' }],
      statements: [statement({ transactions: [row({ category: 'Hobbies:Photography' })] })]
    })
    const created = await service.ensureCategories(doc)
    expect(created).toHaveLength(2)   // Photography (under Hobbies) and Side income; Salary was already there
    expect(await service.ensureCategories(doc)).toEqual([])
    const names = (await accounts.categories.list()).map(c => c.name)
    expect(names).toEqual(expect.arrayContaining(['Hobbies', 'Photography', 'Side income']))
    await fileOf(doc)
    expect((await service.overlayRows(chq.id))[0].categoryLabel).toContain('Photography')
  })
})

describe('accepting a row', () => {
  it('writes an unmatched row as a new transaction, marked E, and removes it from the statement', async () => {
    const { service, fileOf, accounts, chq } = await setupExchange()
    await fileOf(document({ statements: [statement({ transactions: [row({ externalId: 'FIT-1' }), row({ date: '2026-11-05', externalId: 'FIT-2' })] })] }))

    const [waiting] = await service.pendingFor(chq.id)
    await service.accept(chq.id, waiting.id, waiting.rows[0].key)

    const register = await registerOf(accounts, chq.id)
    expect(register).toHaveLength(1)
    expect(register[0]).toMatchObject({ date: '2026-11-03', amount: -14200, payee: 'Hydro Ottawa', status: 'electronic', externalId: 'FIT-1' })

    const [left] = await service.pendingFor(chq.id)
    expect(left.rows).toHaveLength(1)
    expect(left.rows[0].transaction.externalId).toBe('FIT-2')
  })

  it('merges a matched row into the register transaction: the statement’s date, amount and payee win, the category stays', async () => {
    const { service, fileOf, accounts, chq } = await setupExchange()
    const category = await accounts.categories.create('Utilities : Electricity', 'expense')
    const typed = await accounts.transactions(chq.id).create({
      date: '2026-11-01', amount: -14200, payee: 'Hydro', status: 'uncleared', categoryId: category.id
    })
    await fileOf(document({ statements: [statement({ transactions: [row({ payee: 'Hydro Ottawa', externalId: 'FIT-1' })] })] }))

    const [waiting] = await service.pendingFor(chq.id)
    await service.setMatch(chq.id, waiting.id, waiting.rows[0].key, typed.id)
    await service.accept(chq.id, waiting.id, waiting.rows[0].key)

    const register = await registerOf(accounts, chq.id)
    expect(register).toHaveLength(1)
    expect(register[0]).toMatchObject({
      id: typed.id, date: '2026-11-03', amount: -14200, payee: 'Hydro Ottawa', status: 'electronic', externalId: 'FIT-1'
    })
    const updated = await accounts.transactions(chq.id).get(typed.id)
    expect(updated?.categoryId).toBe(category.id)
    expect(await service.pendingFor(chq.id)).toHaveLength(0)
  })

  it('lets go of a row that is already here, writing nothing', async () => {
    const { service, fileOf, accounts, chq } = await setupExchange()
    await fileOf(document({ statements: [statement({ transactions: [row({ externalId: 'FIT-1' })] })] }))
    await accounts.transactions(chq.id).create({ date: '2026-11-03', amount: -14200, status: 'electronic', externalId: 'FIT-1' })

    const [waiting] = await service.pendingFor(chq.id)
    await service.accept(chq.id, waiting.id, waiting.rows[0].key)

    expect(await registerOf(accounts, chq.id)).toHaveLength(1)
    expect(await service.pendingFor(chq.id)).toHaveLength(0)
  })

  it('records the statement’s batch as rows are accepted, and counts the manual matches', async () => {
    const { service, fileOf, accounts, chq } = await setupExchange()
    const typed = await accounts.transactions(chq.id).create({ date: '2026-11-04', amount: -450, payee: 'Daily Grind', status: 'uncleared' })
    await fileOf(document({
      statements: [statement({
        transactions: [row({ externalId: 'FIT-1' }), row({ date: '2026-11-05', amount: -450, payee: 'THE DAILY GRIND #42', externalId: 'FIT-2' })]
      })]
    }))

    const [waiting] = await service.pendingFor(chq.id)
    await service.accept(chq.id, waiting.id, waiting.rows[0].key)
    const [left] = await service.pendingFor(chq.id)
    await service.setMatch(chq.id, left.id, left.rows[0].key, typed.id)
    await service.accept(chq.id, left.id, left.rows[0].key)

    const [batch] = await service.history()
    expect(batch.fileName).toBe('statement.fake')
    expect(batch.counts).toMatchObject({ read: 2, imported: 1, merged: 1 })
    expect(batch.created[0].rows).toHaveLength(1)
    expect(batch.merged[0].id).toBe(typed.id)
    expect(batch.manualMatches).toBe(1)
    // Every written row carries when it was accepted, which is what undo compares against.
    expect(batch.created[0].rows[0].at).toEqual(expect.any(String))
    expect(batch.merged[0].at).toEqual(expect.any(String))
  })
})

describe('matching by hand', () => {
  it('keeps the row unmatched when the user says so, even though the matcher found a match', async () => {
    const { service, fileOf, accounts, chq } = await setupExchange()
    const typed = await accounts.transactions(chq.id).create({ date: '2026-11-02', amount: -14200, payee: 'Hydro Ottawa', status: 'uncleared' })
    await fileOf(document({ statements: [statement({ transactions: [row()] })] }))

    const [waiting] = await service.pendingFor(chq.id)
    expect((await service.overlayRows(chq.id))[0].matchedId).toBe(typed.id)

    await service.setMatch(chq.id, waiting.id, waiting.rows[0].key, null)
    const rows = await service.overlayRows(chq.id)
    expect(rows[0].matchedId).toBeUndefined()
    expect(rows[0].note).toMatch(/New/)

    await service.accept(chq.id, waiting.id, waiting.rows[0].key)
    expect(await registerOf(accounts, chq.id)).toHaveLength(2)
  })

  it('survives a restart: the user’s match is in the book, not in memory', async () => {
    const { service, fileOf, accounts, chq } = await setupExchange()
    const typed = await accounts.transactions(chq.id).create({ date: '2026-11-02', amount: -14200, payee: 'Hydro Ottawa', status: 'uncleared' })
    void typed
    await fileOf(document())
    const [waiting] = await service.pendingFor(chq.id)
    await service.setMatch(chq.id, waiting.id, waiting.rows[0].key, null)

    const [reloaded] = await service.pendingFor(chq.id)
    expect(reloaded.rows[0].userMatch).toBeNull()
  })

  it('takes a transaction the user claimed away from the matcher’s other proposals', async () => {
    const { service, fileOf, accounts, chq } = await setupExchange()
    const typed = await accounts.transactions(chq.id).create({ date: '2026-11-03', amount: -14200, payee: 'Hydro Ottawa', status: 'uncleared' })
    await fileOf(document({
      statements: [statement({ transactions: [row(), row({ date: '2026-11-04', memo: 'second' })] })]
    }))

    const [waiting] = await setupRows(service, chq.id)
    // The second line claims the transaction the matcher would have offered the first
    await service.setMatch(chq.id, waiting.id, waiting.rows[1].key, typed.id)

    const rows = await service.overlayRows(chq.id)
    const first = rows.find(r => r.key.endsWith(':r0'))
    const second = rows.find(r => r.key.endsWith(':r1'))
    expect(second?.matchedId).toBe(typed.id)
    expect(first?.matchedId).toBeUndefined()
  })

  it('refuses a match to a transaction that is not in the register', async () => {
    const { service, fileOf, chq } = await setupExchange()
    await fileOf(document())
    const [waiting] = await service.pendingFor(chq.id)
    const failure = await rejection(service.setMatch(chq.id, waiting.id, waiting.rows[0].key, 'no-such-id'))
    expect(failure.code).toBe('NOT_FOUND')
  })
})

describe('candidates for Change Transaction Matching', () => {
  it('offers the register’s transactions in date order, with payee and category by name', async () => {
    const { service, fileOf, accounts, chq } = await setupExchange()
    const category = await accounts.categories.create('Food : Dining', 'expense')
    await accounts.transactions(chq.id).create({ date: '2026-11-05', amount: -450, payee: 'Daily Grind', status: 'uncleared', categoryId: category.id })
    await accounts.transactions(chq.id).create({ date: '2026-11-01', amount: -14200, payee: 'Hydro', status: 'uncleared' })
    await fileOf(document())

    const [waiting] = await service.pendingFor(chq.id)
    const candidates = await service.matchingCandidates(chq.id, waiting.id, waiting.rows[0].key)
    expect(candidates.map(c => c.date)).toEqual(['2026-11-01', '2026-11-05'])
    expect(candidates[1]).toMatchObject({ payee: 'Daily Grind' })
    expect(candidates[1].categoryLabel).toContain('Dining')
  })

  it('leaves out transactions an earlier import already bank-matched, and ones another pending row claimed', async () => {
    const { service, fileOf, accounts, chq } = await setupExchange()
    const matched = await accounts.transactions(chq.id).create({ date: '2026-11-01', amount: -100, status: 'electronic', externalId: 'OLD-1' })
    const claimed = await accounts.transactions(chq.id).create({ date: '2026-11-02', amount: -200, status: 'uncleared' })
    const free = await accounts.transactions(chq.id).create({ date: '2026-11-03', amount: -300, status: 'uncleared' })
    await fileOf(document({
      statements: [statement({ transactions: [row(), row({ date: '2026-11-04', memo: 'second' })] })]
    }))

    const [waiting] = await service.pendingFor(chq.id)
    await service.setMatch(chq.id, waiting.id, waiting.rows[1].key, claimed.id)

    const candidates = await service.matchingCandidates(chq.id, waiting.id, waiting.rows[0].key)
    const ids = candidates.map(c => c.id)
    expect(ids).toContain(free.id)
    expect(ids).not.toContain(matched.id)
    expect(ids).not.toContain(claimed.id)
  })

  it('always includes the row’s own current match', async () => {
    const { service, fileOf, accounts, chq } = await setupExchange()
    const typed = await accounts.transactions(chq.id).create({ date: '2026-11-02', amount: -14200, payee: 'Hydro Ottawa', status: 'uncleared' })
    await fileOf(document())

    const [waiting] = await service.pendingFor(chq.id)
    const input = await service.matchingInput(chq.id, waiting.id, waiting.rows[0].key)
    expect(input.currentId).toBe(typed.id)
    expect(input.candidates.map(c => c.id)).toContain(typed.id)
    expect(input.entry).toMatchObject({ date: '2026-11-03', amount: -14200, payee: 'Hydro Ottawa' })
  })
})

describe('statements to read', () => {
  it('lists each account with its waiting count, bank balance and local balance', async () => {
    const { service, fileOf, chq } = await setupExchange()
    await fileOf(document({
      statements: [statement({
        balances: { ledger: { amount: 480000, asOf: '2026-11-30' } },
        transactions: [row({ externalId: 'FIT-1' }), row({ date: '2026-11-05', externalId: 'FIT-2' })]
      })]
    }))

    const lines = await service.pendingSummary()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      accountId: chq.id, accountName: 'Chequing', items: 2, bankBalance: 480000, localBalance: 500000
    })
    expect(await service.pendingCount()).toBe(2)
  })

  it('keeps a linked account on the list with nothing waiting, as Money kept its online accounts', async () => {
    const { service, fileOf, acceptAll, chq } = await setupExchange()
    await fileOf(document(), { remember: true })
    await acceptAll(chq.id)

    const lines = await service.pendingSummary()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ accountId: chq.id, items: 0 })
    expect(await service.pendingCount()).toBe(0)
  })
})

describe('undo', () => {
  it('takes the whole statement back out: created rows deleted, merged rows restored', async () => {
    const { service, fileOf, acceptAll, accounts, chq } = await setupExchange()
    const typed = await accounts.transactions(chq.id).create({ date: '2026-11-02', amount: -14200, payee: 'Hydro Ottawa', status: 'uncleared' })
    await fileOf(document({
      statements: [statement({ transactions: [row({ externalId: 'FIT-1' }), row({ date: '2026-11-05', amount: -450, payee: 'The Daily Grind', externalId: 'FIT-2' })] })]
    }))
    await acceptAll(chq.id)

    const [batch] = await service.history()
    const result = await service.undo(batch.id)
    expect(result).toMatchObject({ removed: 1, restored: 1 })

    const register = await registerOf(accounts, chq.id)
    expect(register).toHaveLength(1)
    expect(register[0]).toMatchObject({ id: typed.id, date: '2026-11-02', amount: -14200, status: 'uncleared' })
    expect(register[0].externalId).toBeUndefined()
  })

  it('writes nothing until a row reconciled since the import is confirmed, then takes it too', async () => {
    const { service, fileOf, acceptAll, accounts, chq } = await setupExchange()
    await fileOf(document({ statements: [statement({ transactions: [row({ externalId: 'FIT-1' })] })] }))
    await acceptAll(chq.id)
    const [written] = await registerOf(accounts, chq.id)
    await accounts.transactions(chq.id).setStatus([written.id!], 'reconciled', { confirm: ['reconciled'] })

    const [batch] = await service.history()
    const refusal = await rejection(service.undo(batch.id))
    expect(refusal.code).toBe('CONFIRMATION_REQUIRED')
    expect(refusal.reasons).toContain('reconciled')
    expect(await registerOf(accounts, chq.id)).toHaveLength(1)

    await service.undo(batch.id, { confirm: ['reconciled'] })
    expect(await registerOf(accounts, chq.id)).toHaveLength(0)
  })

  it('refuses the second undo of a batch', async () => {
    const { service, fileOf, acceptAll, chq } = await setupExchange()
    await fileOf(document())
    await acceptAll(chq.id)
    const [batch] = await service.history()
    await service.undo(batch.id)
    expect((await rejection(service.undo(batch.id))).code).toBe('ALREADY_UNDONE')
  })

  it('lists batches newest first, leaving out the undone ones unless asked', async () => {
    const { service, fileOf, acceptAll, chq } = await setupExchange()
    await fileOf(document({ statements: [statement({ transactions: [row({ externalId: 'A-1' })] })] }))
    await acceptAll(chq.id)
    await fileOf(document({ statements: [statement({ transactions: [row({ date: '2026-11-07', externalId: 'B-1' })] })] }), { path: '/in/december.fake' })
    await acceptAll(chq.id)

    const both = await service.history()
    expect(both).toHaveLength(2)
    await service.undo(both[0].id)
    expect(await service.history()).toHaveLength(1)
    expect(await service.history({ includeUndone: true })).toHaveLength(2)
  })
})

/** The account's pending statements, for tests that read them twice. */
async function setupRows(service: { pendingFor(accountId: string): Promise<unknown[]> }, accountId: string) {
  return await service.pendingFor(accountId) as import('@tessera/exchange-api').PendingStatement[]
}
