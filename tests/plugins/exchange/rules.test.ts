// @vitest-environment node
// Payee renaming rules: how they fire, and what "always rename this" learns from an edit.
import { describe, expect, it } from 'vitest'
import type { PayeeRule } from '@tessera/exchange-api'
import { applyPayeeRules, learnedRuleFrom } from '../../../plugins/exchange/src/privileged/rules'
import { document, registerOf, row, setupExchange, statement } from './harness'

let n = 0
const rule = (over: Partial<PayeeRule> = {}): PayeeRule => {
  n += 1
  return {
    id: `r${n}`, order: n,
    match: { kind: 'contains', value: 'daily grind' },
    payee: 'The Daily Grind',
    enabled: true, rev: 1,
    ...over
  }
}

describe('applying rules', () => {
  it('renames from the payee, ignoring case by default', () => {
    const outcome = applyPayeeRules([rule()], { payee: 'SQ *THE DAILY GRIND 4471', accountId: 'a' })
    expect(outcome.payee).toBe('The Daily Grind')
    expect(outcome.applied).toMatchObject({ from: 'SQ *THE DAILY GRIND 4471' })
  })

  it('falls back to the memo, where the bank puts the merchant when the payee is blank', () => {
    const outcome = applyPayeeRules([rule()], { payee: '', memo: 'POS daily grind', accountId: 'a' })
    expect(outcome.payee).toBe('The Daily Grind')
    expect(outcome.applied?.from).toBe('POS daily grind')
  })

  it('takes the first rule in order, not the best match', () => {
    const first = rule({ order: 1, payee: 'First' })
    const second = rule({ order: 2, payee: 'Second' })
    expect(applyPayeeRules([second, first], { payee: 'daily grind', accountId: 'a' }).payee).toBe('First')
  })

  it('honours each kind of match', () => {
    expect(applyPayeeRules([rule({ match: { kind: 'equals', value: 'hydro' } })], { payee: ' Hydro ', accountId: 'a' }).payee).toBeDefined()
    expect(applyPayeeRules([rule({ match: { kind: 'equals', value: 'hydro' } })], { payee: 'Hydro Ottawa', accountId: 'a' }).payee).toBeUndefined()
    expect(applyPayeeRules([rule({ match: { kind: 'startsWith', value: 'sq *' } })], { payee: 'SQ *Anything', accountId: 'a' }).payee).toBeDefined()
  })

  it('respects a case-sensitive rule', () => {
    const strict = rule({ match: { kind: 'contains', value: 'HYDRO', ignoreCase: false } })
    expect(applyPayeeRules([strict], { payee: 'hydro ottawa', accountId: 'a' }).payee).toBeUndefined()
    expect(applyPayeeRules([strict], { payee: 'HYDRO OTTAWA', accountId: 'a' }).payee).toBeDefined()
  })

  it('substitutes a regex’s groups into the new name', () => {
    const pattern = rule({ match: { kind: 'regex', value: '^SQ \\*(.+?) \\d+$' }, payee: '$1' })
    expect(applyPayeeRules([pattern], { payee: 'SQ *Corner Store 881', accountId: 'a' }).payee).toBe('Corner Store')
  })

  it('ignores a rule whose pattern does not compile, rather than failing the import', () => {
    const broken = rule({ match: { kind: 'regex', value: '([unclosed' } })
    expect(() => applyPayeeRules([broken], { payee: 'anything', accountId: 'a' })).not.toThrow()
    expect(applyPayeeRules([broken], { payee: 'anything', accountId: 'a' }).payee).toBeUndefined()
  })

  it('skips a disabled rule, and one scoped to another account', () => {
    expect(applyPayeeRules([rule({ enabled: false })], { payee: 'daily grind', accountId: 'a' }).payee).toBeUndefined()
    expect(applyPayeeRules([rule({ accountId: 'b' })], { payee: 'daily grind', accountId: 'a' }).payee).toBeUndefined()
    expect(applyPayeeRules([rule({ accountId: 'a' })], { payee: 'daily grind', accountId: 'a' }).payee).toBeDefined()
  })

  it('carries a category when the rule names one', () => {
    expect(applyPayeeRules([rule({ categoryId: 'cat-1' })], { payee: 'daily grind', accountId: 'a' }).categoryId).toBe('cat-1')
  })
})

describe('learning a rule from an edit', () => {
  it('matches the merchant’s name with the store number stripped', () => {
    const learned = learnedRuleFrom('SQ *THE DAILY GRIND 4471 OTTAWA ON', 'The Daily Grind')
    expect(learned).toMatchObject({ match: { kind: 'startsWith', value: 'SQ *THE DAILY GRIND' }, learned: true })

    // So next month's different store number fires the same rule
    expect(applyPayeeRules([rule({ ...learned!, id: 'x', rev: 1 })], {
      payee: 'SQ *THE DAILY GRIND 4472 OTTAWA ON', accountId: 'a'
    }).payee).toBe('The Daily Grind')
  })

  it('matches the whole string when there is no usable stem', () => {
    expect(learnedRuleFrom('4471', 'Corner Store')).toMatchObject({ match: { kind: 'equals', value: '4471' } })
    expect(learnedRuleFrom('Hydro Ottawa', 'Hydro')).toMatchObject({ match: { kind: 'equals', value: 'Hydro Ottawa' } })
  })

  it('declines when either side is empty', () => {
    expect(learnedRuleFrom('', 'Something')).toBeUndefined()
    expect(learnedRuleFrom('Something', '   ')).toBeUndefined()
  })
})

describe('rules in the pipeline', () => {
  it('renames a payee before matching, so this month and last month land on one payee', async () => {
    const { service, fileOf, acceptAll, accounts, chq } = await setupExchange()
    await service.payeeRules.replace([{
      order: 0, match: { kind: 'startsWith', value: 'SQ *THE DAILY GRIND' }, payee: 'The Daily Grind', enabled: true
    }])

    await fileOf(document({
      statements: [statement({ transactions: [row({ payee: 'SQ *THE DAILY GRIND 4471 OTTAWA ON', amount: -450 })] })]
    }))
    // The register's provisional row already shows the renamed payee…
    expect((await service.overlayRows(chq.id))[0].payee).toBe('The Daily Grind')

    // …and accepting writes it
    await acceptAll(chq.id)
    expect((await registerOf(accounts, chq.id))[0].payee).toBe('The Daily Grind')
  })

  it('leaves the payee alone when the rules option is switched off', async () => {
    const { service, fileOf, chq } = await setupExchange({ options: { applyRules: false } })
    await service.payeeRules.replace([{
      order: 0, match: { kind: 'contains', value: 'hydro' }, payee: 'Renamed', enabled: true
    }])

    await fileOf(document())
    expect((await service.overlayRows(chq.id))[0].payee).toBe('Hydro Ottawa')
  })

  it('appends a learned rule after the existing ones', async () => {
    const { service } = await setupExchange()
    await service.payeeRules.replace([
      { order: 0, match: { kind: 'contains', value: 'hydro' }, payee: 'Hydro', enabled: true }
    ])
    await service.payeeRules.add([
      { order: 0, match: { kind: 'startsWith', value: 'SQ *' }, payee: 'Square merchant', enabled: true, learned: true }
    ])

    const saved = await service.payeeRules.list()
    expect(saved).toHaveLength(2)
    expect(saved[1]).toMatchObject({ payee: 'Square merchant', learned: true })
    expect(saved[1].order).toBeGreaterThan(saved[0].order)
  })

  it('refuses a rule that says nothing useful', async () => {
    const { service } = await setupExchange()
    await expect(service.payeeRules.replace([
      { order: 0, match: { kind: 'contains', value: '  ' }, payee: 'X', enabled: true }
    ])).rejects.toMatchObject({ code: 'INVALID', field: 'match' })

    await expect(service.payeeRules.replace([
      { order: 0, match: { kind: 'regex', value: '([bad' }, payee: 'X', enabled: true }
    ])).rejects.toMatchObject({ code: 'INVALID' })
  })

  it('keeps rules in the book, so another book starts with none', async () => {
    const { service, session, created } = await setupExchange()
    await service.payeeRules.replace([
      { order: 0, match: { kind: 'contains', value: 'hydro' }, payee: 'Hydro', enabled: true }
    ])
    expect(await service.payeeRules.list()).toHaveLength(1)

    await session.close()
    await created('Business.tessera')
    expect(await service.payeeRules.list()).toEqual([])
  })
})
