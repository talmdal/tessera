// @vitest-environment node
// Payee rules where they actually matter: applied **before** matching, so a renamed payee lands on the
// transaction the user already typed instead of beside it.
//
// `SQ *THE DAILY GRIND 4471 OTTAWA ON` and `The Daily Grind` are the same merchant. If the matcher sees the
// bank's raw text it sees two different ones, calls the row new, and the user accepts a duplicate of a
// transaction sitting directly above it. That was the bug these tests were written for.
import { describe, expect, it } from 'vitest'
import { document, registerOf, rejection, row, setupExchange, statement } from './harness'
import { accountFromStatement } from '../../../plugins/exchange/src/privileged/planning'

const NOISY = 'SQ *THE DAILY GRIND 4471 OTTAWA ON'
const CLEAN = 'The Daily Grind'

/** The book's rule turning the bank's string into the name the user uses. */
const dailyGrindRule = {
  order: 0,
  match: { kind: 'startsWith' as const, value: 'SQ *THE DAILY GRIND', ignoreCase: true },
  payee: CLEAN,
  enabled: true
}

/** A register transaction the user typed, and a statement row for the same purchase under the bank's name. */
async function sameCoffeeTwice(env: Awaited<ReturnType<typeof setupExchange>>) {
  const typed = await env.accounts.transactions(env.chq.id).create({
    date: '2026-11-03', amount: -450, payee: CLEAN
  })
  await env.fileOf(document({
    statements: [statement({ transactions: [row({ date: '2026-11-03', amount: -450, payee: NOISY })] })]
  }))
  return typed
}

describe('a rule applied before matching', () => {
  it('matches the renamed row to the transaction the user typed, rather than calling it new', async () => {
    const env = await setupExchange()
    await env.service.payeeRules.add([dailyGrindRule])
    const typed = await sameCoffeeTwice(env)

    const [overlay] = await env.service.overlayRows(env.chq.id)
    expect(overlay.payee).toBe(CLEAN)
    expect(overlay.matchedId).toBe(typed.id)
    expect(overlay.note).toMatch(/^Matches/)
  })

  it('accepts it as a merge, leaving one transaction rather than two', async () => {
    const env = await setupExchange()
    await env.service.payeeRules.add([dailyGrindRule])
    await sameCoffeeTwice(env)

    const [waiting] = await env.service.pendingFor(env.chq.id)
    await env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key)

    const register = await registerOf(env.accounts, env.chq.id)
    expect(register).toHaveLength(1)
    expect(register[0]).toMatchObject({ payee: CLEAN, status: 'electronic' })
  })

  it('without the rule, the same file produces the duplicate — which is what the rule is for', async () => {
    const env = await setupExchange()
    await sameCoffeeTwice(env)

    const [overlay] = await env.service.overlayRows(env.chq.id)
    expect(overlay.payee).toBe(NOISY)
    expect(overlay.matchedId).toBeUndefined()
    expect(overlay.note).toBe('New')
  })

  it('writes the renamed payee, not the bank’s text, when the row really is new', async () => {
    const env = await setupExchange()
    await env.service.payeeRules.add([dailyGrindRule])
    await env.fileOf(document({
      statements: [statement({ transactions: [row({ date: '2026-11-03', amount: -450, payee: NOISY })] })]
    }))

    const [waiting] = await env.service.pendingFor(env.chq.id)
    await env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key)
    expect((await registerOf(env.accounts, env.chq.id))[0].payee).toBe(CLEAN)
  })

  it('is not applied when the option is off, and then the row does not match', async () => {
    const env = await setupExchange({ options: { applyRules: false } })
    await env.service.payeeRules.add([dailyGrindRule])
    await sameCoffeeTwice(env)

    const [overlay] = await env.service.overlayRows(env.chq.id)
    expect(overlay.payee).toBe(NOISY)
    expect(overlay.matchedId).toBeUndefined()
  })

  it('does not fire a rule scoped to another account', async () => {
    const env = await setupExchange()
    await env.service.payeeRules.add([{ ...dailyGrindRule, accountId: env.savings.id }])
    await sameCoffeeTwice(env)

    const [overlay] = await env.service.overlayRows(env.chq.id)
    expect(overlay.payee).toBe(NOISY)
    expect(overlay.matchedId).toBeUndefined()
  })

  it('matches on the memo when the bank left the payee blank', async () => {
    const env = await setupExchange()
    await env.service.payeeRules.add([dailyGrindRule])
    const typed = await env.accounts.transactions(env.chq.id).create({
      date: '2026-11-03', amount: -450, payee: CLEAN
    })
    await env.fileOf(document({
      statements: [statement({
        transactions: [{ date: '2026-11-03', amount: -450, memo: NOISY }]
      })]
    }))

    const [overlay] = await env.service.overlayRows(env.chq.id)
    expect(overlay.payee).toBe(CLEAN)
    expect(overlay.matchedId).toBe(typed.id)
  })
})

describe('the name the matcher used and the name written', () => {
  it('are the same one, resolved once, so a row cannot match as one payee and land as another', async () => {
    const env = await setupExchange()
    await env.service.payeeRules.add([dailyGrindRule])
    await sameCoffeeTwice(env)

    const [overlay] = await env.service.overlayRows(env.chq.id)
    const [waiting] = await env.service.pendingFor(env.chq.id)
    await env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key)

    const register = await registerOf(env.accounts, env.chq.id)
    expect(register[0].payee).toBe(overlay.payee)
  })
})

describe('renaming one row by hand', () => {
  it('wins over the rules, and the row is written under the user’s name', async () => {
    const env = await setupExchange()
    await env.service.payeeRules.add([dailyGrindRule])
    await env.fileOf(document({
      statements: [statement({ transactions: [row({ date: '2026-11-03', amount: -450, payee: NOISY })] })]
    }))

    const [waiting] = await env.service.pendingFor(env.chq.id)
    await env.service.editRow(env.chq.id, waiting.id, waiting.rows[0].key, { payee: 'Coffee Shop' })

    const [overlay] = await env.service.overlayRows(env.chq.id)
    expect(overlay.payee).toBe('Coffee Shop')

    await env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key)
    expect((await registerOf(env.accounts, env.chq.id))[0].payee).toBe('Coffee Shop')
  })

  it('can change what the row matches, because renaming happens before matching', async () => {
    const env = await setupExchange()
    const typed = await env.accounts.transactions(env.chq.id).create({
      date: '2026-11-03', amount: -450, payee: CLEAN
    })
    await env.fileOf(document({
      statements: [statement({ transactions: [row({ date: '2026-11-03', amount: -450, payee: NOISY })] })]
    }))

    const [waiting] = await env.service.pendingFor(env.chq.id)
    expect((await env.service.overlayRows(env.chq.id))[0].matchedId).toBeUndefined()

    await env.service.editRow(env.chq.id, waiting.id, waiting.rows[0].key, { payee: CLEAN })
    expect((await env.service.overlayRows(env.chq.id))[0].matchedId).toBe(typed.id)
  })

  it('is cleared by null, letting the rules decide again', async () => {
    const env = await setupExchange()
    await env.service.payeeRules.add([dailyGrindRule])
    await env.fileOf(document({
      statements: [statement({ transactions: [row({ date: '2026-11-03', amount: -450, payee: NOISY })] })]
    }))
    const [waiting] = await env.service.pendingFor(env.chq.id)

    await env.service.editRow(env.chq.id, waiting.id, waiting.rows[0].key, { payee: 'Coffee Shop' })
    expect((await env.service.overlayRows(env.chq.id))[0].payee).toBe('Coffee Shop')

    await env.service.editRow(env.chq.id, waiting.id, waiting.rows[0].key, { payee: null })
    expect((await env.service.overlayRows(env.chq.id))[0].payee).toBe(CLEAN)
  })

  it('survives a re-plan, as the user’s own decisions must', async () => {
    const env = await setupExchange()
    await env.fileOf(document({
      statements: [statement({ transactions: [row({ date: '2026-11-03', amount: -450, payee: NOISY })] })]
    }))
    const [waiting] = await env.service.pendingFor(env.chq.id)
    await env.service.editRow(env.chq.id, waiting.id, waiting.rows[0].key, { payee: 'Coffee Shop' })

    // Something else changes in the register; the matcher runs again.
    await env.accounts.transactions(env.chq.id).create({ date: '2026-11-10', amount: -100, payee: 'Other' })
    expect((await env.service.overlayRows(env.chq.id))[0].payee).toBe('Coffee Shop')
  })

  it('refuses a blank name rather than silently clearing the rename', async () => {
    const env = await setupExchange()
    await env.fileOf(document({ statements: [statement({ transactions: [row({ payee: NOISY })] })] }))
    const [waiting] = await env.service.pendingFor(env.chq.id)
    const refused = await rejection(env.service.editRow(env.chq.id, waiting.id, waiting.rows[0].key, { payee: '   ' }))
    expect(refused.code).toBe('INVALID')
  })
})

describe('the rename preview', () => {
  it('shows the match a proposed name would produce, without saving it', async () => {
    const env = await setupExchange()
    const typed = await env.accounts.transactions(env.chq.id).create({
      date: '2026-11-03', amount: -450, payee: CLEAN
    })
    await env.fileOf(document({
      statements: [statement({ transactions: [row({ date: '2026-11-03', amount: -450, payee: NOISY })] })]
    }))
    const [waiting] = await env.service.pendingFor(env.chq.id)
    const key = waiting.rows[0].key

    const preview = await env.service.previewRename(env.chq.id, waiting.id, key, CLEAN)
    expect(preview).toMatchObject({
      payee: CLEAN,
      disposition: 'merge',
      matchedId: typed.id,
      matches: { date: '2026-11-03', amount: -450, payee: CLEAN }
    })
    expect(preview.note).toMatch(/^Matches/)

    // Nothing was saved: the row is still as it was.
    expect((await env.service.overlayRows(env.chq.id))[0].matchedId).toBeUndefined()
  })

  it('shows a row staying new under a name that matches nothing', async () => {
    const env = await setupExchange()
    await env.fileOf(document({
      statements: [statement({ transactions: [row({ date: '2026-11-03', amount: -450, payee: NOISY })] })]
    }))
    const [waiting] = await env.service.pendingFor(env.chq.id)
    const preview = await env.service.previewRename(env.chq.id, waiting.id, waiting.rows[0].key, 'Nobody At All')
    expect(preview).toMatchObject({ payee: 'Nobody At All', disposition: 'new', note: 'New' })
    expect(preview.matchedId).toBeUndefined()
  })

  it('shows what clearing the rename would go back to', async () => {
    const env = await setupExchange()
    await env.service.payeeRules.add([dailyGrindRule])
    await env.fileOf(document({
      statements: [statement({ transactions: [row({ date: '2026-11-03', amount: -450, payee: NOISY })] })]
    }))
    const [waiting] = await env.service.pendingFor(env.chq.id)
    await env.service.editRow(env.chq.id, waiting.id, waiting.rows[0].key, { payee: 'Coffee Shop' })

    const preview = await env.service.previewRename(env.chq.id, waiting.id, waiting.rows[0].key, null)
    expect(preview.payee).toBe(CLEAN)
  })
})

describe('what Rename Payee opens showing', () => {
  it('carries the bank’s own text as well as the tidy name', async () => {
    const env = await setupExchange()
    await env.service.payeeRules.add([dailyGrindRule])
    await env.fileOf(document({
      statements: [statement({ transactions: [row({ date: '2026-11-03', amount: -450, payee: NOISY })] })]
    }))
    const [waiting] = await env.service.pendingFor(env.chq.id)

    const input = await env.service.renameInput(env.chq.id, waiting.id, waiting.rows[0].key)
    expect(input).toMatchObject({
      accountId: env.chq.id,
      statementId: waiting.id,
      rowKey: waiting.rows[0].key,
      original: NOISY,
      payee: CLEAN,
      renamed: false,
      amount: -450,
      date: '2026-11-03'
    })
    expect(input.preview.disposition).toBe('new')
  })

  it('says when the name on show is the user’s own rename rather than a rule’s', async () => {
    const env = await setupExchange()
    await env.fileOf(document({ statements: [statement({ transactions: [row({ payee: NOISY })] })] }))
    const [waiting] = await env.service.pendingFor(env.chq.id)
    await env.service.editRow(env.chq.id, waiting.id, waiting.rows[0].key, { payee: 'Coffee Shop' })

    const input = await env.service.renameInput(env.chq.id, waiting.id, waiting.rows[0].key)
    expect(input).toMatchObject({ original: NOISY, payee: 'Coffee Shop', renamed: true })
  })
})

describe('giving an unmatched row a category', () => {
  /** A statement row that matches nothing, as OFX and most CSV exports deliver it: no category at all. */
  const uncategorised = async (env: Awaited<ReturnType<typeof setupExchange>>) => {
    await env.fileOf(document({
      statements: [statement({ transactions: [row({ date: '2026-11-03', amount: -450, payee: 'Corner Shop' })] })]
    }))
    return (await env.service.pendingFor(env.chq.id))[0]
  }

  it('arrives with none, which is the gap this fills', async () => {
    const env = await setupExchange()
    await uncategorised(env)
    expect((await env.service.overlayRows(env.chq.id))[0].categoryLabel).toBeUndefined()
  })

  it('shows the category the user picked, before the row is accepted', async () => {
    const env = await setupExchange()
    const category = await env.accounts.categories.create('Food : Groceries', 'expense')
    const waiting = await uncategorised(env)

    await env.service.editRow(env.chq.id, waiting.id, waiting.rows[0].key, { categoryId: category.id })
    expect((await env.service.overlayRows(env.chq.id))[0].categoryLabel).toContain('Groceries')
  })

  it('writes it when the row is accepted', async () => {
    const env = await setupExchange()
    const category = await env.accounts.categories.create('Food : Groceries', 'expense')
    const waiting = await uncategorised(env)

    await env.service.editRow(env.chq.id, waiting.id, waiting.rows[0].key, { categoryId: category.id })
    await env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key)

    const [written] = (await env.accounts.transactions(env.chq.id).register()).rows
    expect(written.transaction.categoryId).toBe(category.id)
  })

  it('wins over the category a rule would have set', async () => {
    const env = await setupExchange()
    const byRule = await env.accounts.categories.create('Food : Dining out', 'expense')
    const byHand = await env.accounts.categories.create('Food : Groceries', 'expense')
    await env.service.payeeRules.add([{
      order: 0, match: { kind: 'contains', value: 'Corner Shop', ignoreCase: true },
      payee: 'Corner Shop', categoryId: byRule.id, enabled: true
    }])
    const waiting = await uncategorised(env)
    expect((await env.service.overlayRows(env.chq.id))[0].categoryLabel).toContain('Dining out')

    await env.service.editRow(env.chq.id, waiting.id, waiting.rows[0].key, { categoryId: byHand.id })
    expect((await env.service.overlayRows(env.chq.id))[0].categoryLabel).toContain('Groceries')
  })

  it('is cleared by null, letting the rule decide again', async () => {
    const env = await setupExchange()
    const byRule = await env.accounts.categories.create('Food : Dining out', 'expense')
    const byHand = await env.accounts.categories.create('Food : Groceries', 'expense')
    await env.service.payeeRules.add([{
      order: 0, match: { kind: 'contains', value: 'Corner Shop', ignoreCase: true },
      payee: 'Corner Shop', categoryId: byRule.id, enabled: true
    }])
    const waiting = await uncategorised(env)

    await env.service.editRow(env.chq.id, waiting.id, waiting.rows[0].key, { categoryId: byHand.id })
    await env.service.editRow(env.chq.id, waiting.id, waiting.rows[0].key, { categoryId: null })
    expect((await env.service.overlayRows(env.chq.id))[0].categoryLabel).toContain('Dining out')
  })

  it('survives a re-plan, as the user’s own decisions must', async () => {
    const env = await setupExchange()
    const category = await env.accounts.categories.create('Food : Groceries', 'expense')
    const waiting = await uncategorised(env)
    await env.service.editRow(env.chq.id, waiting.id, waiting.rows[0].key, { categoryId: category.id })

    await env.accounts.transactions(env.chq.id).create({ date: '2026-11-10', amount: -100, payee: 'Other' })
    expect((await env.service.overlayRows(env.chq.id))[0].categoryLabel).toContain('Groceries')
  })

  it('leaves the payee alone when only the category is given, and the other way round', async () => {
    const env = await setupExchange()
    const category = await env.accounts.categories.create('Food : Groceries', 'expense')
    const waiting = await uncategorised(env)
    const key = waiting.rows[0].key

    await env.service.editRow(env.chq.id, waiting.id, key, { payee: 'The Corner Shop' })
    await env.service.editRow(env.chq.id, waiting.id, key, { categoryId: category.id })

    const [overlay] = await env.service.overlayRows(env.chq.id)
    // An absent field means "leave it", which is not the same as null.
    expect(overlay.payee).toBe('The Corner Shop')
    expect(overlay.categoryLabel).toContain('Groceries')
  })

  it('leaves a merged row’s category to the register transaction, which is already the user’s', async () => {
    const env = await setupExchange()
    const theirs = await env.accounts.categories.create('Food : Dining out', 'expense')
    const typed = await env.accounts.transactions(env.chq.id).create({
      date: '2026-11-03', amount: -450, payee: 'Corner Shop', categoryId: theirs.id
    })
    await env.fileOf(document({
      statements: [statement({ transactions: [row({ date: '2026-11-03', amount: -450, payee: 'Corner Shop' })] })]
    }))
    const [waiting] = await env.service.pendingFor(env.chq.id)
    await env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key)

    const [merged] = (await env.accounts.transactions(env.chq.id).register()).rows
    expect(merged.transaction.id).toBe(typed.id)
    expect(merged.transaction.categoryId).toBe(theirs.id)
  })
})

describe('the bank’s own identifiers on an account', () => {
  it('keeps the routing number when an account is created from a statement', () => {
    const prefill = accountFromStatement({
      account: { name: 'Chequing', number: '1234567890', bankId: '001002003', currency: 'CAD', type: 'chequing' },
      transactions: [row()]
    }, '2026-11-19', 'Maple Trust Bank')

    expect(prefill).toMatchObject({
      accountNumber: '1234567890',
      routingNumber: '001002003',
      institution: 'Maple Trust Bank'
    })
  })

  it('leaves it out when the file carried none, rather than inventing one', () => {
    const prefill = accountFromStatement({
      account: { name: 'Savings', currency: 'CAD' },
      transactions: [row()]
    }, '2026-11-19')
    expect(prefill?.routingNumber).toBeUndefined()
    expect(prefill?.institution).toBeUndefined()
  })
})
