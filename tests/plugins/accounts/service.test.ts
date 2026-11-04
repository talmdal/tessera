// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { chequing, rejection, setupAccounts } from './harness'

describe('creating accounts', () => {
  it('stores a checked, normalised account, placed last in its sub-ledger', async () => {
    const { service, session } = await setupAccounts()
    const personal = await session.createSubLedger({ name: 'Personal', parentId: null })
    await service.createAccount(chequing({ subLedgerId: personal.id }))

    const savings = await service.createAccount(chequing({
      name: '  Savings ', type: 'savings', subLedgerId: personal.id, currency: 'cad', institution: ' TD ', accountNumber: '123-456', notes: ''
    }))

    expect(savings).toEqual({
      id: expect.any(String), rev: expect.any(Number), name: 'Savings', type: 'savings', subLedgerId: personal.id, currency: 'CAD',
      openingDate: '2026-01-01', openingBalance: 100000, institution: 'TD', accountNumber: '123-456', order: 1, closed: false
    })
    expect(await service.get(savings.id)).toEqual(savings)
  })

  it('refuses a name another account has, ignoring case, wherever it is', async () => {
    const { service, session } = await setupAccounts()
    const business = await session.createSubLedger({ name: 'Business', parentId: null })
    await service.createAccount(chequing())
    const err = await rejection(service.createAccount(chequing({ name: 'CHEQUING ', subLedgerId: business.id })))
    expect(err).toMatchObject({ code: 'DUPLICATE_NAME', field: 'name', message: 'There is already an account named “Chequing”.' })
  })

  it('names the field at fault for every kind of bad input', async () => {
    const { service } = await setupAccounts()
    const fieldOf = async (over: object) => (await rejection(service.createAccount(chequing(over as never)))).field
    expect(await fieldOf({ name: ' ' })).toBe('name')
    expect(await fieldOf({ type: 'bitcoin' })).toBe('type')
    expect(await fieldOf({ currency: 'XYZ' })).toBe('currency')
    expect(await fieldOf({ openingDate: '2026-02-30' })).toBe('openingDate')
    expect(await fieldOf({ openingBalance: 1.5 })).toBe('openingBalance')
    expect(await fieldOf({ creditLimit: 500000 })).toBe('creditLimit')                         // a chequing account
    expect(await fieldOf({ type: 'creditCard', creditLimit: -1 })).toBe('creditLimit')
    expect(await fieldOf({ institution: 'x'.repeat(101) })).toBe('institution')
    expect(await fieldOf({ accountNumber: 'a\u0000b' })).toBe('accountNumber')
    expect(await fieldOf({ subLedgerId: 'gone' })).toBe('subLedgerId')
    expect((await rejection(service.createAccount(chequing({ subLedgerId: 'gone' })))).code).toBe('NOT_FOUND')
  })

  it('keeps a credit card\'s limit, and its balance owed as a negative amount', async () => {
    const { service } = await setupAccounts()
    const visa = await service.createAccount(chequing({ name: 'Visa', type: 'creditCard', openingBalance: -54000, creditLimit: 500000 }))
    expect(visa).toMatchObject({ openingBalance: -54000, creditLimit: 500000 })
    expect(await service.balances(visa.id)).toEqual({ current: -54000, available: -54000, cleared: -54000, reconciled: -54000, transactionCount: 0 })
  })

  it('fails with NO_LEDGER while no ledger is open', async () => {
    const { service } = await setupAccounts({ open: false })
    expect((await rejection(service.createAccount(chequing()))).code).toBe('NO_LEDGER')
    expect((await rejection(service.list())).code).toBe('NO_LEDGER')
  })
})

describe('editing accounts', () => {
  it('moves an account back to the ledger itself with subLedgerId null, which is a place, not a clearing', async () => {
    const { service, session } = await setupAccounts()
    const personal = await session.createSubLedger({ name: 'Personal', parentId: null })
    const a = await service.createAccount(chequing({ subLedgerId: personal.id }))
    await expect(service.updateAccount(a.id, { subLedgerId: null })).resolves.toMatchObject({ subLedgerId: null })
  })

  it('changes only what the patch names, and clears optional fields given as null', async () => {
    const { service } = await setupAccounts()
    const a = await service.createAccount(chequing({ institution: 'TD', notes: 'Joint' }))

    const edited = await service.updateAccount(a.id, { name: 'Everyday', institution: null })

    expect(edited).toMatchObject({ name: 'Everyday', type: 'chequing', openingBalance: 100000, notes: 'Joint' })
    expect(edited).not.toHaveProperty('institution')
    expect(edited.rev).toBeGreaterThan(a.rev)
  })

  it('detects a change made elsewhere, and keeps its own name free for itself', async () => {
    const { service } = await setupAccounts()
    const a = await service.createAccount(chequing())
    await service.createAccount(chequing({ name: 'Savings' }))
    await service.updateAccount(a.id, { notes: 'first' }, { expectedRev: a.rev })
    expect((await rejection(service.updateAccount(a.id, { notes: 'second' }, { expectedRev: a.rev }))).code).toBe('CONFLICT')
    expect((await rejection(service.updateAccount(a.id, { name: 'savings' }))).code).toBe('DUPLICATE_NAME')
    await expect(service.updateAccount(a.id, { name: 'CHEQUING' })).resolves.toMatchObject({ name: 'CHEQUING' })
  })

  it('drops a credit limit when the type changes to one without, and moves with a new sub-ledger', async () => {
    const { service, session } = await setupAccounts()
    const personal = await session.createSubLedger({ name: 'Personal', parentId: null })
    const card = await service.createAccount(chequing({ name: 'Visa', type: 'creditCard', creditLimit: 100 }))
    const loan = await service.updateAccount(card.id, { type: 'loan', subLedgerId: personal.id })
    expect(loan).not.toHaveProperty('creditLimit')
    expect(loan).toMatchObject({ type: 'loan', subLedgerId: personal.id, order: 0 })
  })

  it('refuses to change a closed account until it is reopened', async () => {
    const { service } = await setupAccounts()
    const a = await service.createAccount(chequing({ openingBalance: 0 }))
    await service.closeAccount(a.id)
    expect(await rejection(service.updateAccount(a.id, { name: 'X' }))).toMatchObject({ code: 'ACCOUNT_CLOSED', message: '“Chequing” is closed. Reopen it to change it.' })
    await service.reopenAccount(a.id)
    await expect(service.updateAccount(a.id, { name: 'X' })).resolves.toMatchObject({ name: 'X' })
  })
})

describe('closing, reopening and deleting', () => {
  it('closes on a date, asking for confirmation when there is a balance', async () => {
    const { service } = await setupAccounts()
    const a = await service.createAccount(chequing())

    // The amount is in the system's locale: "$1,000.00" in Canada, "CA$1,000.00" in the US
    expect(await rejection(service.closeAccount(a.id))).toMatchObject({
      code: 'CONFIRMATION_REQUIRED', reasons: ['closeWithBalance'], message: expect.stringMatching(/^“Chequing” has a balance of .*1,000\.00\.$/)
    })
    expect(await service.closeAccount(a.id, { confirm: ['closeWithBalance'] })).toMatchObject({ closed: true, closedOn: '2026-11-04' })
    // Closing a closed account changes nothing
    expect((await service.closeAccount(a.id)).closedOn).toBe('2026-11-04')

    const reopened = await service.reopenAccount(a.id)
    expect(reopened.closed).toBe(false)
    expect(reopened).not.toHaveProperty('closedOn')
  })

  it('deletes an account for good', async () => {
    const { service } = await setupAccounts()
    const a = await service.createAccount(chequing())
    await service.deleteAccount(a.id)
    expect(await service.get(a.id)).toBeUndefined()
    expect((await rejection(service.deleteAccount(a.id))).code).toBe('NOT_FOUND')
  })
})

describe('moving and ordering', () => {
  it('moves between sub-ledgers and reorders within one', async () => {
    const { service, session } = await setupAccounts()
    const personal = await session.createSubLedger({ name: 'Personal', parentId: null })
    const a = await service.createAccount(chequing({ name: 'A' }))
    const b = await service.createAccount(chequing({ name: 'B' }))
    const c = await service.createAccount(chequing({ name: 'C' }))

    await service.moveAccount(c.id, null, 0)
    expect((await service.list({ subLedgerId: null })).map(x => x.name)).toEqual(['C', 'A', 'B'])
    await service.moveAccount(a.id, personal.id)
    expect((await service.list({ subLedgerId: personal.id })).map(x => x.name)).toEqual(['A'])
    expect((await service.list({ subLedgerId: null })).map(x => [x.name, x.order])).toEqual([['C', 0], ['B', 1]])
    void b
    expect((await rejection(service.moveAccount(a.id, 'gone'))).code).toBe('NOT_FOUND')
  })

  it('lists in navigator order: under each node its sub-ledgers with their contents, then its own accounts', async () => {
    const { service, session } = await setupAccounts()
    const personal = await session.createSubLedger({ name: 'Personal', parentId: null })
    const rentals = await session.createSubLedger({ name: 'Rentals', parentId: personal.id })
    await service.createAccount(chequing({ name: 'Root account' }))
    await service.createAccount(chequing({ name: 'Personal account', subLedgerId: personal.id }))
    await service.createAccount(chequing({ name: 'Cottage', subLedgerId: rentals.id }))
    expect((await service.list()).map(a => a.name)).toEqual(['Cottage', 'Personal account', 'Root account'])
  })
})

describe('finding accounts (for importers and reports)', () => {
  async function stocked() {
    const env = await setupAccounts()
    const personal = await env.session.createSubLedger({ name: 'Personal', parentId: null })
    const rentals = await env.session.createSubLedger({ name: 'Rentals', parentId: personal.id })
    await env.service.createAccount(chequing({ name: 'TD Chequing', institution: 'TD', accountNumber: '004-12345-6789012', subLedgerId: personal.id }))
    await env.service.createAccount(chequing({ name: 'Visa', type: 'creditCard', institution: 'td ', accountNumber: '4520 1111 2222 9012', openingBalance: -100 }))
    await env.service.createAccount(chequing({ name: 'US Savings', type: 'savings', currency: 'USD', subLedgerId: rentals.id }))
    const old = await env.service.createAccount(chequing({ name: 'Old', openingBalance: 0 }))
    await env.service.closeAccount(old.id)
    return { ...env, personal, rentals }
  }
  const names = (accounts: { name: string }[]) => accounts.map(a => a.name).sort()

  it('matches an account number exactly, or by its last digits, ignoring spaces and dashes', async () => {
    const { service } = await stocked()
    expect(names(await service.list({ accountNumber: '004 12345 6789012' }))).toEqual(['TD Chequing'])
    expect(names(await service.list({ accountNumber: { endsWith: '9012' } }))).toEqual(['TD Chequing', 'Visa'])
    expect(names(await service.list({ accountNumber: { endsWith: '9012' }, institution: 'TD', types: ['creditCard'] }))).toEqual(['Visa'])
    expect(await service.list({ accountNumber: '' })).toEqual([])
  })

  it('filters by place (with or without what is beneath), class, currency and closed state', async () => {
    const { service, personal } = await stocked()
    expect(names(await service.list({ subLedgerId: personal.id }))).toEqual(['TD Chequing'])
    expect(names(await service.list({ subLedgerId: personal.id, includeDescendants: true }))).toEqual(['TD Chequing', 'US Savings'])
    expect(names(await service.list({ classes: ['liability'] }))).toEqual(['Visa'])
    expect(names(await service.list({ currency: 'usd' }))).toEqual(['US Savings'])
    expect(names(await service.list({ includeClosed: false }))).not.toContain('Old')
    expect(names(await service.list())).toContain('Old')
  })

  it('charts the tree with balances, and totals per currency through every sub-ledger above an account', async () => {
    const { service, personal, rentals } = await stocked()
    const chart = await service.chart()
    expect(chart.ledger.name).toBe('Home')
    expect(chart.totals).toEqual({ CAD: 100000 - 100, USD: 100000 })
    expect(chart.subLedgers.find(s => s.id === personal.id)!.totals).toEqual({ CAD: 100000, USD: 100000 })
    expect(chart.subLedgers.find(s => s.id === rentals.id)!.totals).toEqual({ USD: 100000 })
    expect(chart.accounts.map(s => s.account.name)).toEqual(['US Savings', 'TD Chequing', 'Visa', 'Old'])
    expect((await service.chart({ includeClosed: false })).accounts.map(s => s.account.name)).not.toContain('Old')
  })
})

describe('sub-ledgers and the ledger', () => {
  it('moves a deleted sub-ledger\'s accounts to its parent, and says how many there were', async () => {
    const { service, session, changes } = await setupAccounts()
    const business = await session.createSubLedger({ name: 'Business', parentId: null })
    await service.createAccount(chequing({ name: 'Root' }))
    const shop = await service.createAccount(chequing({ name: 'Shop', subLedgerId: business.id }))
    await service.createAccount(chequing({ name: 'Till', subLedgerId: business.id }))
    expect(await service.participant.describe(business.id)).toBe('2 accounts')
    changes.length = 0

    await session.deleteSubLedger(business.id)

    expect((await service.list()).map(a => [a.name, a.subLedgerId, a.order])).toEqual([['Root', null, 0], ['Shop', null, 1], ['Till', null, 2]])
    expect(changes).toEqual([expect.objectContaining({ updated: expect.arrayContaining([shop.id]), chart: true })])
  })

  it('announces a change when a ledger opens or closes, since the accounts are then others', async () => {
    const { service, session, changes } = await setupAccounts()
    await session.close()
    expect(changes.at(-1)).toMatchObject({ chart: true })
    expect((await rejection(service.chart())).code).toBe('NO_LEDGER')
  })
})

describe('change events', () => {
  it('say what each write touched, once it is stored', async () => {
    const { service, changes } = await setupAccounts()
    const a = await service.createAccount(chequing())
    await service.updateAccount(a.id, { notes: 'x' })
    await service.updateAccount(a.id, { openingBalance: 5 })
    await service.deleteAccount(a.id)

    expect(changes.map(c => [c.created, c.updated, c.deleted, c.balances])).toEqual([
      [[a.id], [], [], [a.id]],
      [[], [a.id], [], []],
      [[], [a.id], [], [a.id]],
      [[], [], [a.id], [a.id]]
    ])
  })

  it('fire for nothing that failed', async () => {
    const { service, changes } = await setupAccounts()
    await rejection(service.createAccount(chequing({ name: '' })))
    expect(changes).toEqual([])
  })
})
