import { describe, it, expect } from 'vitest'
import { resolveOptionPages, type ContributedOptionsPage } from '../../shared/options/resolveOptionPages'

const remoteEntryFor = (pluginId: string) => pluginId === 'noui' ? undefined : `tessera-plugin://${pluginId}/remoteEntry.js`

const page = (contributor: string, impl: Record<string, unknown>): ContributedOptionsPage => ({ contributor, impl })

/** Page ids, depth first, as the tree holds them. */
const ids = (pages: { id: string, children: any[] }[]): string[] =>
  pages.flatMap(node => [node.id, ...ids(node.children)])

describe('resolving option pages: validation', () => {
  it('takes a well-formed page, with the contributor as the namespace it edits', () => {
    const { pages, diagnostics } = resolveOptionPages(
      [page('book', { id: 'book.options', title: 'Book', module: './BookOptions', keywords: ['backup'], order: 5 })],
      remoteEntryFor)

    expect(diagnostics).toEqual([])
    expect(pages).toEqual([{
      id: 'book.options', title: 'Book', pluginId: 'book', module: './BookOptions',
      remoteEntry: 'tessera-plugin://book/remoteEntry.js', keywords: ['backup'], children: []
    }])
  })

  it('takes a category: no module, so no renderer needed', () => {
    const { pages, diagnostics } = resolveOptionPages([page('shell', { id: 'shell.options.general', title: 'General' })], () => undefined)

    expect(diagnostics).toEqual([])
    expect(pages[0]).toMatchObject({ id: 'shell.options.general', title: 'General', keywords: [], children: [] })
    expect(pages[0].module).toBeUndefined()
  })

  it.each([
    ['not an object', 'book', 'nonsense', /is not an object/],
    ['missing an id', 'book', { title: 'Book' }, /missing an id/],
    ['missing a title', 'book', { id: 'book.options' }, /missing a title/],
    ['owned by another plugin', 'book', { id: 'ledger.options', title: 'X' }, /must be "book" or start with "book\."/],
    ['a module that is not exposed', 'book', { id: 'book.o', title: 'X', module: 'BookOptions' }, /must name an exposed module/],
    ['an invalid order', 'book', { id: 'book.o', title: 'X', order: Number.NaN }, /invalid order/],
    ['invalid keywords', 'book', { id: 'book.o', title: 'X', keywords: [1] }, /invalid keywords/],
    ['an invalid parent', 'book', { id: 'book.o', title: 'X', parent: 7 }, /invalid parent/],
    ['its own parent', 'book', { id: 'book.o', title: 'X', parent: 'book.o' }, /its own parent/]
  ])('skips a page that is %s, and says why', (_label, contributor, impl, expected) => {
    const { pages, diagnostics } = resolveOptionPages([page(contributor, impl as Record<string, unknown>)], remoteEntryFor)

    expect(pages).toEqual([])
    expect(diagnostics).toEqual([expect.stringMatching(expected)])
  })

  it('skips a page whose plugin has no renderer, since its module could never load', () => {
    const { pages, diagnostics } = resolveOptionPages([page('noui', { id: 'noui.o', title: 'X', module: './X' })], remoteEntryFor)

    expect(pages).toEqual([])
    expect(diagnostics).toEqual([expect.stringMatching(/has no renderer entry/)])
  })

  it('keeps the first of two pages sharing an id', () => {
    const { pages, diagnostics } = resolveOptionPages([
      page('book', { id: 'book.o', title: 'First' }),
      page('book', { id: 'book.o', title: 'Second' })
    ], remoteEntryFor)

    expect(pages.map(p => p.title)).toEqual(['First'])
    expect(diagnostics).toEqual([expect.stringMatching(/Duplicate option page id/)])
  })

  it('lets one bad contribution through without costing the others', () => {
    const { pages, diagnostics } = resolveOptionPages([
      page('book', { id: 'book.o', title: 'Book' }),
      page('ledger', 'rubbish'),
      page('budget', { id: 'budget.o', title: 'Budget' })
    ], remoteEntryFor)

    expect(ids(pages)).toEqual(['book.o', 'budget.o'])
    expect(diagnostics).toHaveLength(1)
  })
})

describe('resolving option pages: the tree', () => {
  it('nests a page under its parent, however deep', () => {
    const { pages, diagnostics } = resolveOptionPages([
      page('shell', { id: 'shell.options.general', title: 'General' }),
      page('book', { id: 'book.options', title: 'Book', parent: 'shell.options.general' }),
      page('book', { id: 'book.options.backup', title: 'Backups', parent: 'book.options', module: './B' })
    ], remoteEntryFor)

    expect(diagnostics).toEqual([])
    expect(ids(pages)).toEqual(['shell.options.general', 'book.options', 'book.options.backup'])
    expect(pages[0].children[0].children[0].title).toBe('Backups')
  })

  it('places a page contributed before its parent, since plugins activate in dependency order', () => {
    const { pages, diagnostics } = resolveOptionPages([
      page('book', { id: 'book.options', title: 'Book', parent: 'shell.options.general' }),
      page('shell', { id: 'shell.options.general', title: 'General' })
    ], remoteEntryFor)

    expect(diagnostics).toEqual([])
    expect(ids(pages)).toEqual(['shell.options.general', 'book.options'])
  })

  it('skips a page whose parent nobody contributed', () => {
    const { pages, diagnostics } = resolveOptionPages([page('book', { id: 'book.o', title: 'X', parent: 'nobody' })], remoteEntryFor)

    expect(pages).toEqual([])
    expect(diagnostics).toEqual([expect.stringMatching(/unknown parent "nobody"/)])
  })

  it('skips the children of a page that was itself skipped', () => {
    const { pages, diagnostics } = resolveOptionPages([
      page('book', { id: 'book.parent', title: 'X', parent: 'nobody' }),
      page('book', { id: 'book.child', title: 'Y', parent: 'book.parent' })
    ], remoteEntryFor)

    expect(pages).toEqual([])
    expect(diagnostics).toHaveLength(2)
  })

  it('skips pages whose parents form a cycle, without hanging', () => {
    const { pages, diagnostics } = resolveOptionPages([
      page('book', { id: 'book.a', title: 'A', parent: 'book.b' }),
      page('book', { id: 'book.b', title: 'B', parent: 'book.a' })
    ], remoteEntryFor)

    expect(pages).toEqual([])
    expect(diagnostics).toEqual([expect.stringMatching(/cycle/), expect.stringMatching(/cycle/)])
  })

  it('sorts siblings by order, then by the order they were contributed', () => {
    const { pages } = resolveOptionPages([
      page('shell', { id: 'shell.options.general', title: 'General' }),
      page('b', { id: 'b.late', title: 'Late', parent: 'shell.options.general', order: 10 }),
      page('c', { id: 'c.first', title: 'First', parent: 'shell.options.general', order: -1 }),
      page('d', { id: 'd.tieA', title: 'Tie A', parent: 'shell.options.general' }),
      page('e', { id: 'e.tieB', title: 'Tie B', parent: 'shell.options.general' })
    ], remoteEntryFor)

    expect(pages[0].children.map(child => child.title)).toEqual(['First', 'Tie A', 'Tie B', 'Late'])
  })

  it('sorts the roots the same way', () => {
    const { pages } = resolveOptionPages([
      page('a', { id: 'a', title: 'A', order: 5 }),
      page('b', { id: 'b', title: 'B', order: 1 })
    ], remoteEntryFor)

    expect(pages.map(p => p.title)).toEqual(['B', 'A'])
  })

  it('is empty, and says nothing, when nobody contributes a page', () => {
    expect(resolveOptionPages([], remoteEntryFor)).toEqual({ pages: [], diagnostics: [] })
  })
})
