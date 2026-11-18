// @vitest-environment node
// What accepting must never do: lose a purchase by merging two bank rows into one transaction, or write the
// same row twice. Found in review; each test here failed before its fix.
import { describe, expect, it } from 'vitest'
import { STATEMENT_RECONCILER } from '@tessera/accounts-api'
import { document, registerOf, rejection, row, setupExchange, statement } from './harness'

/** Two identical coffees from a file with no row ids (CSV, QIF), and one the user typed. */
async function twoCoffees(env: Awaited<ReturnType<typeof setupExchange>>) {
  await env.accounts.transactions(env.chq.id).create({ date: '2026-11-03', amount: -450, payee: 'Coffee' })
  await env.fileOf(document({
    statements: [statement({
      transactions: [
        { date: '2026-11-03', amount: -450, payee: 'Coffee' },
        { date: '2026-11-03', amount: -450, payee: 'Coffee' }
      ]
    })]
  }))
}

const acceptFirst = async (env: Awaited<ReturnType<typeof setupExchange>>) => {
  const [waiting] = await env.service.pendingFor(env.chq.id)
  await env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key)
}

describe('a transaction a bank row has already merged into', () => {
  it('is not offered to a second identical row, which is a second purchase', async () => {
    const env = await setupExchange()
    await twoCoffees(env)
    await acceptFirst(env)
    await acceptFirst(env)

    // Two coffees bought, two in the register: the typed one (now reported) and a new one.
    expect(await registerOf(env.accounts, env.chq.id)).toHaveLength(2)
    const [batch] = await env.service.history()
    expect(batch.counts).toMatchObject({ merged: 1, imported: 1 })
  })

  it('is not offered across two statements waiting in the same account either', async () => {
    const env = await setupExchange()
    await env.accounts.transactions(env.chq.id).create({ date: '2026-11-03', amount: -450, payee: 'Coffee' })
    // An October export and an overlapping "last 30 days" export, both holding the same coffee.
    for (const path of ['/in/statement.fake', '/in/december.fake']) {
      await env.fileOf(document({
        statements: [statement({ transactions: [{ date: '2026-11-03', amount: -450, payee: 'Coffee' }] })]
      }), { path })
    }
    // Only one of the two may claim the typed transaction, even before either is accepted.
    const rows = await env.service.overlayRows(env.chq.id)
    expect(rows.filter(r => r.matchedId !== undefined)).toHaveLength(1)
  })
})

describe('accepting the same row twice at once', () => {
  it('writes it once; the second accept finds the row already taken', async () => {
    const env = await setupExchange()
    await env.fileOf(document({
      statements: [statement({ transactions: [{ date: '2026-11-03', amount: -450, payee: 'Coffee' }] })]
    }))
    const [waiting] = await env.service.pendingFor(env.chq.id)
    const key = waiting.rows[0].key

    // A double-click: both calls start before either finishes.
    const results = await Promise.allSettled([
      env.service.accept(env.chq.id, waiting.id, key),
      env.service.accept(env.chq.id, waiting.id, key)
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(await registerOf(env.accounts, env.chq.id)).toHaveLength(1)
    const [batch] = await env.service.history()
    expect(batch.counts.imported).toBe(1)
  })
})

void rejection; void row

describe('a write that cannot be recorded', () => {
  it('is taken back out, so no transaction exists that no batch knows about', async () => {
    const env = await setupExchange()
    await env.fileOf(document({
      statements: [statement({ transactions: [{ date: '2026-11-03', amount: -450, payee: 'Coffee' }] })]
    }))
    const [waiting] = await env.service.pendingFor(env.chq.id)

    // Recording fails after the transaction was written through accounts.service.
    const service = env.service as unknown as { recordAcceptance: () => Promise<boolean> }
    service.recordAcceptance = async () => { throw new Error('storage refused') }

    await expect(env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key)).rejects.toThrow('storage refused')
    expect(await registerOf(env.accounts, env.chq.id)).toEqual([])
    // And the row is still waiting, so accepting it again later writes it once, not twice.
    expect((await env.service.pendingFor(env.chq.id))[0].rows).toHaveLength(1)
  })
})

describe('trimming the history', () => {
  it('never drops a batch whose statement is still being read', async () => {
    const env = await setupExchange({ options: { keep: 1 } })
    // Statement 1: two rows, one accepted — its batch is open.
    await env.fileOf(document({
      statements: [statement({ transactions: [row({ externalId: 'A' }), row({ externalId: 'B', amount: -99 })] })]
    }), { path: '/in/statement.fake' })
    const [first] = await env.service.pendingFor(env.chq.id)
    await env.service.accept(env.chq.id, first.id, first.rows[0].key)

    // Statement 2, read through: its batch closes, and trimming runs with keep = 1.
    await env.fileOf(document({
      statements: [statement({ transactions: [row({ externalId: 'C', amount: -77 })] })]
    }), { path: '/in/december.fake' })
    const second = (await env.service.pendingFor(env.chq.id)).find(s => s.id !== first.id)!
    await env.service.accept(env.chq.id, second.id, second.rows[0].key)

    // Statement 1's batch is open, so trimming to one left it alone — even though it is the older of the two.
    const history = await env.service.history()
    expect(history).toHaveLength(2)
    const open = history.find(b => b.closedAt === undefined)!
    expect(open.counts).toMatchObject({ read: 2, imported: 1 })

    // And its last row joins *that* batch, rather than the acceptance being recorded nowhere.
    const left = (await env.service.pendingFor(env.chq.id)).find(s => s.id === first.id)!
    expect(left.batchId).toBe(open.id)
  })
})

describe('a batch that has gone missing', () => {
  it('is opened afresh for the next accepted row, rather than the acceptance being dropped', async () => {
    const env = await setupExchange()
    await env.fileOf(document({
      statements: [statement({ transactions: [row({ externalId: 'A' }), row({ externalId: 'B', amount: -99 })] })]
    }))
    const [waiting] = await env.service.pendingFor(env.chq.id)
    await env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key)

    // The statement still points at its batch, but the batch is gone.
    const [lost] = await env.service.history()
    await env.session.database('exchange').collection('exchange.batches').deleteOne({ id: lost.id })

    const left = (await env.service.pendingFor(env.chq.id))[0]
    await env.service.accept(env.chq.id, left.id, left.rows[0].key)

    // The second row is in a batch, so Undo Import can still reach it.
    const [reopened] = await env.service.history()
    expect(reopened.id).not.toBe(lost.id)
    expect(reopened.counts.imported).toBe(1)
    expect((await env.service.undo(reopened.id)).removed).toBe(1)
  })
})

describe('undoing an import that withdrew a transaction', () => {
  it('un-voids it, rather than restoring its status and leaving it voided', async () => {
    const env = await setupExchange()
    await env.fileOf(document({ statements: [statement({ transactions: [row({ externalId: 'X' })] })] }))
    let [waiting] = await env.service.pendingFor(env.chq.id)
    await env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key)

    // A later file from the bank withdraws X (OFX CORRECTACTION DELETE).
    await env.fileOf(document({
      statements: [statement({ transactions: [row({ externalId: 'X2', corrects: { externalId: 'X', action: 'delete' } })] })]
    }), { path: '/in/december.fake' })
    ;[waiting] = await env.service.pendingFor(env.chq.id)
    await env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key)

    const voidedNow = (await env.accounts.transactions(env.chq.id).register()).rows[0].transaction
    expect(voidedNow.voided).toBe(true)

    const [withdrawal] = await env.service.history()
    await env.service.undo(withdrawal.id, { confirm: ['editedSince', 'reconciled'] })
    const after = (await env.accounts.transactions(env.chq.id).register()).rows[0].transaction
    expect(after.voided).toBe(false)
  })
})

describe('undoing a statement still being read', () => {
  it('sends its next accepted row into a new batch, which can itself be undone', async () => {
    const env = await setupExchange()
    await env.fileOf(document({
      statements: [statement({ transactions: [row({ externalId: 'A' }), row({ externalId: 'B', amount: -99 })] })]
    }))
    const [waiting] = await env.service.pendingFor(env.chq.id)
    await env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key)
    const [first] = await env.service.history()
    await env.service.undo(first.id)

    const left = (await env.service.pendingFor(env.chq.id))[0]
    expect(left.batchId).toBeUndefined()
    await env.service.accept(env.chq.id, left.id, left.rows[0].key)

    // The new row is visible in the history and undoable — not buried in the batch already undone.
    const [second] = await env.service.history()
    expect(second.id).not.toBe(first.id)
    expect((await env.service.undo(second.id)).removed).toBe(1)
    expect(await registerOf(env.accounts, env.chq.id)).toEqual([])
  })
})

describe('a line that matches a reconciled transaction', () => {
  /** A reconciled transaction, and a statement line the matcher pairs with it. */
  async function reconciledMatch(env: Awaited<ReturnType<typeof setupExchange>>) {
    const typed = await env.accounts.transactions(env.chq.id).create({
      date: '2026-11-01', amount: -450, payee: 'Coffee'
    })
    // Reconciled the only way a transaction can be: against a statement, through the account.
    const opening = env.chq.openingBalance
    await env.accounts.reconciliation.begin(env.chq.id, {
      statementDate: '2026-11-02', startingBalance: opening, statementBalance: opening - 450,
      reconcilerId: STATEMENT_RECONCILER
    })
    await env.accounts.reconciliation.mark(env.chq.id, [typed.id], true)
    await env.accounts.reconciliation.finish(env.chq.id)
    await env.fileOf(document({
      statements: [statement({ transactions: [{ date: '2026-11-03', amount: -450, payee: 'Coffee' }] })]
    }))
    const [waiting] = await env.service.pendingFor(env.chq.id)
    return { typed, waiting }
  }

  it('is not merged on one click: accept asks first and writes nothing', async () => {
    const env = await setupExchange()
    const { typed, waiting } = await reconciledMatch(env)
    const refused = await rejection(env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key))
    expect(refused.code).toBe('CONFIRMATION_REQUIRED')
    expect(refused.reasons).toEqual(['reconciled'])

    const still = await env.accounts.transactions(env.chq.id).get(typed.id)
    expect(still?.date).toBe('2026-11-01')
    expect((await env.service.pendingFor(env.chq.id))[0].rows).toHaveLength(1)
  })

  it('is merged once the user confirms', async () => {
    const env = await setupExchange()
    const { typed, waiting } = await reconciledMatch(env)
    await env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key, { confirm: ['reconciled'] })
    expect((await env.accounts.transactions(env.chq.id).get(typed.id))?.date).toBe('2026-11-03')
  })
})
