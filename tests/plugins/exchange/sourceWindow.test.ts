// @vitest-environment node
// A statement source's own matching window. Posting lag is a property of the bank — one posts the next day,
// another a week later — so the window that decides whether a statement line and a typed transaction are the
// same one can be set per source, overriding the option for that source only.
import { describe, expect, it } from 'vitest'
import { document, rejection, row, setupExchange, statement } from './harness'

/**
 * The user typed the purchase on the 1st; the bank posted it on the 8th — a week late, beyond the option's
 * default of 3 days either side. Filed with `remember`, so the source is linked to the chequing account.
 */
async function postedLate(env: Awaited<ReturnType<typeof setupExchange>>) {
  const typed = await env.accounts.transactions(env.chq.id).create({
    date: '2026-11-01', amount: -7550, payee: 'Telus'
  })
  await env.fileOf(document({
    statements: [statement({ transactions: [row({ date: '2026-11-08', amount: -7550, payee: 'Telus' })] })]
  }), { remember: true })
  const [link] = await env.service.links()
  return { typed, link }
}

const overlay = async (env: Awaited<ReturnType<typeof setupExchange>>) =>
  (await env.service.overlayRows(env.chq.id))[0]

describe('without a window of its own', () => {
  it('a source uses the option, and a week-late posting does not match', async () => {
    const env = await setupExchange()
    const { link } = await postedLate(env)
    expect(link.dateWindow).toBeUndefined()

    const row = await overlay(env)
    expect(row.matchedId).toBeUndefined()
    expect(row.note).toBe('New')
  })
})

describe('with a window of its own', () => {
  it('matches the late posting to the transaction the user typed', async () => {
    const env = await setupExchange()
    const { typed, link } = await postedLate(env)

    await env.service.updateLink(link.id, { dateWindow: 7 })

    const row = await overlay(env)
    expect(row.matchedId).toBe(typed.id)
    expect(row.note).toMatch(/^Matches/)
  })

  it('accepts it as a merge, leaving one transaction instead of a duplicate', async () => {
    const env = await setupExchange()
    const { link } = await postedLate(env)
    await env.service.updateLink(link.id, { dateWindow: 7 })

    const [waiting] = await env.service.pendingFor(env.chq.id)
    await env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key)
    expect((await env.accounts.transactions(env.chq.id).register()).rows).toHaveLength(1)
  })

  it('can be tighter than the option too: 0 means the same day only', async () => {
    const env = await setupExchange()
    await env.accounts.transactions(env.chq.id).create({ date: '2026-11-01', amount: -7550, payee: 'Telus' })
    await env.fileOf(document({
      statements: [statement({ transactions: [row({ date: '2026-11-02', amount: -7550, payee: 'Telus' })] })]
    }), { remember: true })
    // One day late: inside the option's 3, so it matches…
    expect((await overlay(env)).matchedId).toBeDefined()

    // …until this source is told it always posts on the day.
    const [link] = await env.service.links()
    await env.service.updateLink(link.id, { dateWindow: 0 })
    expect((await overlay(env)).matchedId).toBeUndefined()
  })

  it('goes back to the option when cleared with null', async () => {
    const env = await setupExchange()
    const { link } = await postedLate(env)
    await env.service.updateLink(link.id, { dateWindow: 7 })
    expect((await overlay(env)).matchedId).toBeDefined()

    const cleared = await env.service.updateLink(link.id, { dateWindow: null })
    expect(cleared.dateWindow).toBeUndefined()
    expect((await overlay(env)).matchedId).toBeUndefined()
  })

  it('applies only to that source: another bank’s statement in the same account keeps the option', async () => {
    const env = await setupExchange()
    const { link } = await postedLate(env)
    await env.service.updateLink(link.id, { dateWindow: 7 })

    // A different source — another account number — filed into the same register, also a week late.
    await env.accounts.transactions(env.chq.id).create({ date: '2026-11-10', amount: -1200, payee: 'Netflix' })
    await env.fileOf(document({
      statements: [statement({
        account: { number: '5550009999', currency: 'CAD' },
        transactions: [row({ date: '2026-11-17', amount: -1200, payee: 'Netflix', externalId: 'NF-1' })]
      })]
    }), { path: '/in/december.fake' })

    const rows = await env.service.overlayRows(env.chq.id)
    const netflix = rows.find(r => r.payee === 'Netflix')!
    const telus = rows.find(r => r.payee === 'Telus')!
    expect(telus.matchedId).toBeDefined()
    expect(netflix.matchedId).toBeUndefined()
  })

  it('does not apply to a statement of that source filed by hand into some other account', async () => {
    const env = await setupExchange()
    const { link } = await postedLate(env)
    await env.service.updateLink(link.id, { dateWindow: 7 })

    // The same source's file, put in the savings account instead of the one it is linked to.
    await env.accounts.transactions(env.savings.id).create({ date: '2026-11-01', amount: -7550, payee: 'Telus' })
    const read = await env.readOf(document({
      statements: [statement({ transactions: [row({ date: '2026-11-08', amount: -7550, payee: 'Telus', externalId: 'T-SAV' })] })]
    }), '/in/january.fake')
    await env.service.file(read.document.statements[0], env.savings.id, {
      source: { fileName: read.fileName, fileHash: read.fileHash, formatId: read.document.formatId }
    })

    expect((await env.service.overlayRows(env.savings.id))[0].matchedId).toBeUndefined()
  })

})

describe('updateLink', () => {
  it('keeps the window when the source is imported and remembered again', async () => {
    const env = await setupExchange()
    const { link } = await postedLate(env)
    await env.service.updateLink(link.id, { dateWindow: 7 })

    // Next month's file from the same source, remembered again: the link is refreshed, not reset.
    await env.fileOf(document({
      statements: [statement({ transactions: [row({ date: '2026-12-08', amount: -7550, payee: 'Telus', externalId: 'T-DEC' })] })]
    }), { remember: true, path: '/in/december.fake' })

    const [again] = await env.service.links()
    expect(again.dateWindow).toBe(7)
  })

  it('leaves the window alone when the patch does not mention it', async () => {
    const env = await setupExchange()
    const { link } = await postedLate(env)
    await env.service.updateLink(link.id, { dateWindow: 7 })
    const unchanged = await env.service.updateLink(link.id, {})
    expect(unchanged.dateWindow).toBe(7)
  })

  it('refuses a window outside the option’s own range', async () => {
    const env = await setupExchange()
    const { link } = await postedLate(env)
    for (const dateWindow of [-1, 61, 2.5, Number.NaN]) {
      const refused = await rejection(env.service.updateLink(link.id, { dateWindow }))
      expect(refused.code).toBe('INVALID')
      expect(refused.field).toBe('dateWindow')
    }
  })

  it('refuses a link that is no longer there', async () => {
    const env = await setupExchange()
    const { link } = await postedLate(env)
    await env.service.removeLink(link.id)
    const refused = await rejection(env.service.updateLink(link.id, { dateWindow: 7 }))
    expect(refused.code).toBe('NOT_FOUND')
  })

  it('tells the register to redraw, since the source’s waiting statements re-match at once', async () => {
    const env = await setupExchange()
    const { link } = await postedLate(env)
    const changes: { pending: string[], links: boolean }[] = []
    env.service.onDidChange(change => changes.push(change))

    await env.service.updateLink(link.id, { dateWindow: 7 })
    expect(changes.at(-1)).toMatchObject({ links: true, pending: [env.chq.id] })
  })
})
