// @vitest-environment node
// When each row of a batch was written, and what undo makes of it.
//
// A batch is accreted: it opens with the first accepted row and stays open until the statement has no rows
// left, which may be several sittings later. That makes "has this row been edited since it was imported?" a
// question about the *row*, not the batch — and getting it wrong in either direction is a real failure. These
// tests pin both directions, because the obvious single-timestamp implementations each get one of them right.
import { describe, expect, it } from 'vitest'
import { document, registerOf, rejection, row, setupExchange, statement } from './harness'

/** A statement of two new rows, filed against the chequing account. */
async function twoRows(env: Awaited<ReturnType<typeof setupExchange>>) {
  await env.fileOf(document({
    statements: [statement({
      transactions: [
        row({ date: '2026-11-03', amount: -14200, payee: 'Hydro', externalId: 'A' }),
        row({ date: '2026-11-04', amount: -2500, payee: 'Coffee', externalId: 'B' })
      ]
    })]
  }))
  return (await env.service.pendingFor(env.chq.id))[0]
}

/** Accepts the first row still waiting in the account, and returns the statement as it stood. */
async function acceptFirst(env: Awaited<ReturnType<typeof setupExchange>>) {
  const [waiting] = await env.service.pendingFor(env.chq.id)
  await env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key)
  return waiting
}

describe('a row edited between two acceptances', () => {
  it('is noticed, and undo asks before discarding the edit', async () => {
    const env = await setupExchange()
    await twoRows(env)

    // Monday: accept the first row.
    await acceptFirst(env)
    const imported = (await registerOf(env.accounts, env.chq.id)).find(r => r.externalId === 'A')!

    // Tuesday: the user edits it by hand.
    await env.accounts.transactions(env.chq.id).update(imported.id, { memo: 'MY OWN EDIT' })

    // Wednesday: accept the second row. The batch grows; the first row's moment does not move.
    await acceptFirst(env)

    const [batch] = await env.service.history()
    const refused = await rejection(env.service.undo(batch.id))
    expect(refused.code).toBe('CONFIRMATION_REQUIRED')
    expect(refused.reasons).toContain('editedSince')

    // And nothing was written: the edit is still there to be reconsidered.
    expect((await registerOf(env.accounts, env.chq.id)).some(r => r.memo === 'MY OWN EDIT')).toBe(true)
  })

  it('goes too once the user confirms, restored to its pre-import state rather than to the edit', async () => {
    const env = await setupExchange()
    await twoRows(env)
    await acceptFirst(env)
    const imported = (await registerOf(env.accounts, env.chq.id)).find(r => r.externalId === 'A')!
    await env.accounts.transactions(env.chq.id).update(imported.id, { memo: 'MY OWN EDIT' })
    await acceptFirst(env)

    const [batch] = await env.service.history()
    const result = await env.service.undo(batch.id, { confirm: ['editedSince'] })
    expect(result.removed).toBe(2)
    expect(await registerOf(env.accounts, env.chq.id)).toEqual([])
  })
})

describe('a row merely accepted later in the same batch', () => {
  it('is not reported as edited, which is the false positive the per-row time avoids', async () => {
    const env = await setupExchange()
    await twoRows(env)

    // Both rows accepted, nothing touched by hand in between.
    await acceptFirst(env)
    await acceptFirst(env)

    const [batch] = await env.service.history()
    // A single `importedAt` fixed at the first acceptance would flag the second row here.
    const result = await env.service.undo(batch.id)
    expect(result.removed).toBe(2)
    expect(await registerOf(env.accounts, env.chq.id)).toEqual([])
  })
})

describe('the batch’s own timestamps', () => {
  it('keeps importedAt at the first acceptance and moves lastAcceptedAt to the most recent', async () => {
    const env = await setupExchange()
    await twoRows(env)

    await acceptFirst(env)
    const [afterOne] = await env.service.history()
    expect(afterOne.lastAcceptedAt).toBe(afterOne.importedAt)

    await acceptFirst(env)
    const [afterTwo] = await env.service.history()
    // The import is still the moment it began; the latest acceptance has moved on.
    expect(afterTwo.importedAt).toBe(afterOne.importedAt)
    expect(afterTwo.lastAcceptedAt > afterOne.lastAcceptedAt).toBe(true)
  })

  it('stays open while the statement has rows left, and closes when it has none', async () => {
    const env = await setupExchange()
    await twoRows(env)

    await acceptFirst(env)
    expect((await env.service.history())[0].closedAt).toBeUndefined()
    // Still open, and still one batch: the second row joins it rather than starting another.
    expect(await env.service.pendingFor(env.chq.id)).toHaveLength(1)

    await acceptFirst(env)
    const history = await env.service.history()
    expect(history).toHaveLength(1)
    expect(history[0].closedAt).toEqual(expect.any(String))
    expect(await env.service.pendingFor(env.chq.id)).toEqual([])
  })

  it('undoes the whole statement however many sittings it took', async () => {
    const env = await setupExchange()
    await twoRows(env)
    await acceptFirst(env)
    await acceptFirst(env)

    const [batch] = await env.service.history()
    expect(batch.counts.imported).toBe(2)
    const result = await env.service.undo(batch.id)
    expect(result.removed).toBe(2)
  })
})

describe('a merged row', () => {
  it('carries its own time too, so an edit after the merge is noticed', async () => {
    const env = await setupExchange()
    // A transaction the user typed, which the statement's row will merge into.
    const typed = await env.accounts.transactions(env.chq.id).create({
      date: '2026-11-03', amount: -14200, payee: 'Hydro'
    })
    await env.fileOf(document({
      statements: [statement({
        transactions: [
          row({ date: '2026-11-03', amount: -14200, payee: 'Hydro', externalId: 'A' }),
          row({ date: '2026-11-04', amount: -2500, payee: 'Coffee', externalId: 'B' })
        ]
      })]
    }))

    await acceptFirst(env)
    const [batch] = await env.service.history()
    expect(batch.merged[0]).toMatchObject({ id: typed.id, at: expect.any(String) })

    // Edited by hand, then the second row accepted.
    await env.accounts.transactions(env.chq.id).update(typed.id, { memo: 'MY OWN EDIT' })
    await acceptFirst(env)

    const refused = await rejection(env.service.undo(batch.id))
    expect(refused.reasons).toContain('editedSince')
  })
})

describe('trimming the history', () => {
  /** Reads and fully accepts a one-row statement from `path`, closing its batch. */
  const importOne = async (env: Awaited<ReturnType<typeof setupExchange>>, path: string, externalId: string) => {
    await env.fileOf(
      document({ statements: [statement({ transactions: [row({ externalId })] })] }),
      { path }
    )
    const [waiting] = await env.service.pendingFor(env.chq.id)
    await env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key)
  }

  it('keeps only the most recent batches, oldest dropped first', async () => {
    const env = await setupExchange({ options: { keep: 2 } })
    await importOne(env, '/in/statement.fake', 'A')
    await importOne(env, '/in/december.fake', 'B')
    await importOne(env, '/in/january.fake', 'C')

    const history = await env.service.history({ includeUndone: true })
    expect(history).toHaveLength(2)
    // The first import is gone; the two most recent remain.
    expect(history.map(b => b.fileName)).toEqual(['january.fake', 'december.fake'])
  })

  it('deletes a trimmed batch rather than emptying it, so nothing looks undoable when it is not', async () => {
    const env = await setupExchange({ options: { keep: 1 } })
    await importOne(env, '/in/statement.fake', 'A')
    const [first] = await env.service.history()
    await importOne(env, '/in/december.fake', 'B')

    // The batch is not merely marked: it is no longer in the book at all.
    const refused = await rejection(env.service.undo(first.id))
    expect(refused.code).toBe('NOT_FOUND')
  })

  it('does not trim while a statement is still being read, since its batch is still open', async () => {
    const env = await setupExchange({ options: { keep: 1 } })
    await importOne(env, '/in/statement.fake', 'A')

    // A second statement, only half accepted: its batch is open, so nothing is trimmed yet.
    await env.fileOf(document({
      statements: [statement({
        transactions: [row({ externalId: 'B' }), row({ externalId: 'C', amount: -999 })]
      })]
    }), { path: '/in/december.fake' })
    const [waiting] = await env.service.pendingFor(env.chq.id)
    await env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key)

    expect(await env.service.history({ includeUndone: true })).toHaveLength(2)
  })
})
