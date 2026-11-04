// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { childrenOf, isBookError, type SubBook } from '@tessera/book-api'
import { contributor, setupSession } from './harness'

/** The tree as "parent > name" lines, in display order, for readable expectations. */
function outline(subBooks: SubBook[], parentId: string | null = null, depth = 0): string[] {
  return childrenOf(subBooks, parentId).flatMap(s => [`${'  '.repeat(depth)}${s.name}`, ...outline(subBooks, s.id, depth + 1)])
}

const code = async (work: Promise<unknown>) => {
  const err = await work.then(() => undefined, e => e)
  expect(isBookError(err), String(err)).toBe(true)
  return (err as { code: string }).code
}

/** An open book; `accounts` declares `accounts.things`, as a participant must declare what it writes. */
async function ready() {
  const env = setupSession()
  env.contribute(contributor('accounts', 1))
  await env.created()
  const tree = async () => outline((await env.session.tree()).subBooks)
  return { ...env, tree }
}

describe('sub-books', () => {
  it('are created in the book and inside each other, in the order they were made', async () => {
    const { session, tree } = await ready()
    const personal = await session.createSubBook({ name: 'Personal', parentId: null })
    await session.createSubBook({ name: 'Business', parentId: null })
    await session.createSubBook({ name: '  Rentals  ', parentId: personal.id, notes: 'The cottage' })

    expect(await tree()).toEqual(['Personal', '  Rentals', 'Business'])
    const rentals = (await session.tree()).subBooks.find(s => s.name === 'Rentals')!
    expect(rentals).toMatchObject({ parentId: personal.id, order: 0, notes: 'The cottage', rev: expect.any(Number) })
  })

  it('needs a usable name, unique among its siblings ignoring case', async () => {
    const { session } = await ready()
    const personal = await session.createSubBook({ name: 'Personal', parentId: null })

    expect(await code(session.createSubBook({ name: 'personal ', parentId: null }))).toBe('DUPLICATE_NAME')
    expect(await code(session.createSubBook({ name: '   ', parentId: null }))).toBe('INVALID')
    expect(await code(session.createSubBook({ name: 'a/b', parentId: null }))).toBe('INVALID')
    expect(await code(session.createSubBook({ name: 'x'.repeat(101), parentId: null }))).toBe('INVALID')
    // The same name elsewhere in the tree is fine
    await expect(session.createSubBook({ name: 'Personal', parentId: personal.id })).resolves.toMatchObject({ name: 'Personal' })
  })

  it('reports the field a name error is about, for the dialog to show it there', async () => {
    const { session } = await ready()
    await session.createSubBook({ name: 'Personal', parentId: null })
    const err = await session.createSubBook({ name: 'Personal', parentId: null }).catch(e => e)
    expect(err).toMatchObject({ code: 'DUPLICATE_NAME', field: 'name', message: 'There is already a “Personal” there.' })
  })

  it('refuses a parent that does not exist, and everything while no book is open', async () => {
    const { session } = await ready()
    expect(await code(session.createSubBook({ name: 'Lost', parentId: 'nope' }))).toBe('NOT_FOUND')
    await session.close()
    expect(await code(session.createSubBook({ name: 'Any', parentId: null }))).toBe('NO_BOOK')
    expect(await code(session.tree())).toBe('NO_BOOK')
  })

  it('are renamed, keeping their place; a stale revision is a conflict', async () => {
    const { session, tree } = await ready()
    const a = await session.createSubBook({ name: 'A', parentId: null })
    await session.createSubBook({ name: 'B', parentId: null })

    const renamed = await session.renameSubBook(a.id, 'Alpha', { expectedRev: a.rev })
    expect(await tree()).toEqual(['Alpha', 'B'])
    expect(renamed.rev).toBeGreaterThan(a.rev)
    expect(await code(session.renameSubBook(a.id, 'Again', { expectedRev: a.rev }))).toBe('CONFLICT')
    expect(await code(session.renameSubBook(a.id, 'b'))).toBe('DUPLICATE_NAME')
    // Changing only the case of its own name is allowed
    await expect(session.renameSubBook(a.id, 'ALPHA')).resolves.toMatchObject({ name: 'ALPHA' })
    expect(await code(session.renameSubBook('nope', 'X'))).toBe('NOT_FOUND')
  })

  it('move between parents and within one, renumbering their siblings', async () => {
    const { session, tree } = await ready()
    const a = await session.createSubBook({ name: 'A', parentId: null })
    const b = await session.createSubBook({ name: 'B', parentId: null })
    const c = await session.createSubBook({ name: 'C', parentId: null })

    await session.moveSubBook(c.id, null, 0)
    expect(await tree()).toEqual(['C', 'A', 'B'])

    await session.moveSubBook(b.id, a.id)
    expect(await tree()).toEqual(['C', 'A', '  B'])
    expect(childrenOf((await session.tree()).subBooks, null).map(s => s.order)).toEqual([0, 1])

    await session.moveSubBook(b.id, null, 99)     // an index past the end means last
    expect(await tree()).toEqual(['C', 'A', 'B'])

    await session.moveSubBook(a.id, c.id)          // out of the middle: no gap left behind
    expect(childrenOf((await session.tree()).subBooks, null).map(s => [s.name, s.order])).toEqual([['C', 0], ['B', 1]])
  })

  it('never move into themselves or their own descendants, or beside a namesake', async () => {
    const { session } = await ready()
    const a = await session.createSubBook({ name: 'A', parentId: null })
    const child = await session.createSubBook({ name: 'Child', parentId: a.id })
    const grandchild = await session.createSubBook({ name: 'Grandchild', parentId: child.id })
    await session.createSubBook({ name: 'Child', parentId: null })

    expect(await code(session.moveSubBook(a.id, a.id))).toBe('CYCLE')
    expect(await code(session.moveSubBook(a.id, grandchild.id))).toBe('CYCLE')
    expect(await code(session.moveSubBook(child.id, null))).toBe('DUPLICATE_NAME')
    expect(await code(session.moveSubBook(a.id, 'nope'))).toBe('NOT_FOUND')
  })

  it('when deleted, hand their sub-books to their parent, renaming any that clash, and lose nothing', async () => {
    const { session, tree } = await ready()
    const personal = await session.createSubBook({ name: 'Personal', parentId: null })
    const business = await session.createSubBook({ name: 'Business', parentId: null })
    await session.createSubBook({ name: 'Personal', parentId: business.id })   // clashes with the top-level one
    await session.createSubBook({ name: 'Business', parentId: business.id })   // named like its parent, which goes
    await session.createSubBook({ name: 'Shop', parentId: business.id })
    void personal

    await session.deleteSubBook(business.id)

    expect(await tree()).toEqual(['Personal', 'Personal (2)', 'Business', 'Shop'])
  })

  it('call every participant inside the deleting transaction, with a transaction limited to its own data', async () => {
    const { session, driver } = await ready()
    const business = await session.createSubBook({ name: 'Business', parentId: null })
    const reparent = vi.fn(async (tx: any, from: string, to: string | null) => {
      expect(() => tx.collection('ledger.subledgers')).toThrow('may only use names starting with "accounts."')
      await tx.collection('accounts.things').insert({ name: `moved from ${from} to ${to}` })
    })
    session.participate('accounts', { describe: async () => '4 accounts', reparent })

    await session.deleteSubBook(business.id)

    expect(reparent).toHaveBeenCalledWith(expect.anything(), business.id, null)
    const things = [...driver.databases.values()][0].collections.get('accounts.things')
    expect([...things!.docs.values()].map((d: any) => d.name)).toEqual([`moved from ${business.id} to null`])
  })

  it('stay as they were when a participant fails: the whole delete is rolled back', async () => {
    const { session, tree } = await ready()
    const business = await session.createSubBook({ name: 'Business', parentId: null })
    await session.createSubBook({ name: 'Shop', parentId: business.id })
    session.participate('accounts', {
      describe: async () => undefined,
      reparent: async tx => { await tx.collection('accounts.things').insert({ name: 'half done' }); throw new Error('disk full') }
    })

    await expect(session.deleteSubBook(business.id)).rejects.toThrow('disk full')
    expect(await tree()).toEqual(['Business', '  Shop'])
  })

  it('describe their contents through the participants, for the confirmation', async () => {
    const { session, log } = await ready()
    const business = await session.createSubBook({ name: 'Business', parentId: null })
    session.participate('accounts', { describe: async id => id === business.id ? '4 accounts' : undefined, reparent: async () => {} })
    const stop = session.participate('budgets', { describe: async () => { throw new Error('oops') }, reparent: async () => {} })

    expect(await session.describeContents(business.id)).toEqual(['4 accounts'])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('"budgets" could not describe'))

    stop.dispose()
    expect(() => session.participate('accounts', { describe: async () => undefined, reparent: async () => {} })).toThrow('already takes part')
  })

  it('announce every change of the tree, with the whole tree', async () => {
    const { session } = await ready()
    const trees: string[][] = []
    session.onDidChangeTree(tree => trees.push(tree.subBooks.map(s => s.name)))

    const a = await session.createSubBook({ name: 'A', parentId: null })
    await session.renameSubBook(a.id, 'Alpha')
    await session.deleteSubBook(a.id)

    expect(trees).toEqual([['A'], ['Alpha'], []])
  })
})
