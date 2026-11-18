// @vitest-environment node
// Putting statement rows aside, and the three things that follow from it: `counts.skipped` finally means
// something, the history records a file the user took nothing from, and a file already read through is
// recognised the next time it is opened.
import { describe, expect, it } from 'vitest'
import { document, registerOf, rejection, row, setupExchange, statement } from './harness'

/** A statement of two rows, filed against the chequing account. */
async function twoRows(env: Awaited<ReturnType<typeof setupExchange>>, path = '/in/statement.fake') {
  await env.fileOf(document({
    statements: [statement({
      transactions: [
        row({ date: '2026-11-03', amount: -14200, payee: 'Hydro', externalId: 'A' }),
        row({ date: '2026-11-04', amount: -2500, payee: 'Coffee', externalId: 'B' })
      ]
    })]
  }), { path })
  return (await env.service.pendingFor(env.chq.id))[0]
}

describe('skipping one row', () => {
  it('takes it out of the register without writing anything', async () => {
    const env = await setupExchange()
    const waiting = await twoRows(env)

    expect(await env.service.dismiss(env.chq.id, waiting.id, waiting.rows[0].key)).toBe(1)

    const left = await env.service.pendingFor(env.chq.id)
    expect(left[0].rows.map(r => r.transaction.externalId)).toEqual(['B'])
    expect(await registerOf(env.accounts, env.chq.id)).toEqual([])
  })

  it('counts it as skipped on the statement’s batch, rather than forgetting it', async () => {
    const env = await setupExchange()
    const waiting = await twoRows(env)
    await env.service.dismiss(env.chq.id, waiting.id, waiting.rows[0].key)

    const [batch] = await env.service.history({ includeUndone: true })
    expect(batch.counts).toMatchObject({ read: 2, imported: 0, skipped: 1 })
  })

  it('joins the batch an accepted row already opened', async () => {
    const env = await setupExchange()
    const waiting = await twoRows(env)
    await env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key)

    const left = (await env.service.pendingFor(env.chq.id))[0]
    await env.service.dismiss(env.chq.id, left.id, left.rows[0].key)

    const history = await env.service.history({ includeUndone: true })
    // One statement, one batch: accepted one row and left the other.
    expect(history).toHaveLength(1)
    expect(history[0].counts).toMatchObject({ imported: 1, skipped: 1 })
    expect(history[0].closedAt).toEqual(expect.any(String))
  })

  it('refuses a row that is no longer waiting', async () => {
    const env = await setupExchange()
    const waiting = await twoRows(env)
    const refused = await rejection(env.service.dismiss(env.chq.id, waiting.id, 'no-such-row'))
    expect(refused.code).toBe('NOT_FOUND')
  })
})

describe('putting a whole statement aside', () => {
  it('clears it, counting every row left as skipped', async () => {
    const env = await setupExchange()
    const waiting = await twoRows(env)

    expect(await env.service.dismiss(env.chq.id, waiting.id)).toBe(2)
    expect(await env.service.pendingFor(env.chq.id)).toEqual([])
    expect(await registerOf(env.accounts, env.chq.id)).toEqual([])
  })

  it('records it in the history, because reading a file and taking nothing is still something that happened', async () => {
    const env = await setupExchange()
    const waiting = await twoRows(env)
    await env.service.dismiss(env.chq.id, waiting.id)

    const [batch] = await env.service.history({ includeUndone: true })
    expect(batch).toMatchObject({ fileName: 'statement.fake', closedAt: expect.any(String) })
    expect(batch.counts).toMatchObject({ read: 2, imported: 0, merged: 0, skipped: 2 })
  })

  it('leaves a batch with nothing to undo, and the history says so', async () => {
    const env = await setupExchange()
    const waiting = await twoRows(env)
    await env.service.dismiss(env.chq.id, waiting.id)

    const [entry] = await env.service.historyEntries({ includeUndone: true })
    expect(entry.blocked).toBe('Nothing was written')
  })

  it('does nothing, and says nothing, when there is nothing left to put aside', async () => {
    const env = await setupExchange()
    const waiting = await twoRows(env)
    await env.service.dismiss(env.chq.id, waiting.id)
    const refused = await rejection(env.service.dismiss(env.chq.id, waiting.id))
    expect(refused.code).toBe('NOT_FOUND')
  })
})

describe('reading the same file again', () => {
  it('is refused once the file has been read through, so a second Import is a question', async () => {
    const env = await setupExchange()
    const waiting = await twoRows(env)
    await env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key)
    await env.service.accept(env.chq.id, (await env.service.pendingFor(env.chq.id))[0].id, 'r1')

    const refused = await rejection(env.fileOf(document({
      statements: [statement({ transactions: [row({ externalId: 'A' })] })]
    }), { path: '/in/statement.fake' }))

    expect(refused.code).toBe('ALREADY_IMPORTED')
    expect(refused.message).toContain('statement.fake')
  })

  it('is refused for a file the user put aside, which the history also records', async () => {
    const env = await setupExchange()
    const waiting = await twoRows(env)
    await env.service.dismiss(env.chq.id, waiting.id)

    const refused = await rejection(env.fileOf(document({
      statements: [statement({ transactions: [row({ externalId: 'A' })] })]
    }), { path: '/in/statement.fake' }))
    expect(refused.code).toBe('ALREADY_IMPORTED')
  })

  it('goes ahead when the caller says so, and the row-level duplicate check still runs', async () => {
    const env = await setupExchange()
    const waiting = await twoRows(env)
    await env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key)

    const read = await env.readOf(document({
      statements: [statement({ transactions: [row({ externalId: 'A' }), row({ externalId: 'C', amount: -999 })] })]
    }), '/in/december.fake')
    const result = await env.service.file(read.document.statements[0], env.chq.id, {
      source: { fileName: read.fileName, fileHash: read.fileHash, formatId: read.document.formatId },
      force: true
    })
    // `A` is already in the register; only `C` is new.
    expect(result).toMatchObject({ filed: 1, duplicates: 1 })
  })

  it('is allowed again once the import has been undone, which is how a user asks to redo it', async () => {
    const env = await setupExchange()
    const waiting = await twoRows(env)
    await env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key)
    await env.service.accept(env.chq.id, (await env.service.pendingFor(env.chq.id))[0].id, 'r1')
    const [batch] = await env.service.history()
    await env.service.undo(batch.id)

    const again = await env.fileOf(document({
      statements: [statement({ transactions: [row({ externalId: 'A' })] })]
    }), { path: '/in/statement.fake' })
    expect(again.filed).toBe(1)
  })

  it('does not stop the same file being read into a different account', async () => {
    const env = await setupExchange()
    const waiting = await twoRows(env)
    await env.service.dismiss(env.chq.id, waiting.id)

    // The savings account has never seen this file, so nothing is in its way.
    const read = await env.readOf(document({
      statements: [statement({ transactions: [row({ externalId: 'A' })] })]
    }), '/in/statement.fake')
    const result = await env.service.file(read.document.statements[0], env.savings.id, {
      source: { fileName: read.fileName, fileHash: read.fileHash, formatId: read.document.formatId }
    })
    expect(result.filed).toBe(1)
  })
})

describe('what an import brought into being', () => {
  it('is recorded on the batch, so Undo Import can name what it is leaving behind', async () => {
    const env = await setupExchange()
    const category = await env.accounts.categories.create('Food : Groceries', 'expense')

    const read = await env.readOf(document({
      statements: [statement({ transactions: [row({ externalId: 'A' })] })]
    }))
    await env.service.file(read.document.statements[0], env.chq.id, {
      source: { fileName: read.fileName, fileHash: read.fileHash, formatId: read.document.formatId },
      created: { accounts: [env.chq.id], categories: [category.id] }
    })

    const waiting = (await env.service.pendingFor(env.chq.id))[0]
    await env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key)

    const [batch] = await env.service.history()
    expect(batch.createdAccounts).toEqual([env.chq.id])
    expect(batch.createdCategories).toEqual([category.id])

    // And undo names them rather than removing them.
    const result = await env.service.undo(batch.id)
    expect(result.kept.accounts).toEqual(['Chequing'])
    expect(result.kept.categories).toEqual(['Groceries'])
  })

  it('is empty for an import that created nothing', async () => {
    const env = await setupExchange()
    const waiting = await twoRows(env)
    await env.service.accept(env.chq.id, waiting.id, waiting.rows[0].key)

    const [batch] = await env.service.history()
    expect(batch.createdAccounts).toEqual([])
    expect(batch.createdCategories).toEqual([])
  })
})
