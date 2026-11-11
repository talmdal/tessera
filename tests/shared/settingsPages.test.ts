import { describe, expect, it } from 'vitest'
import type { SettingsField } from '@tessera/types'
import { fieldDefinitionProblem, fieldValueProblem, fieldsProblems } from '../../shared/settings/fields'
import { NamespaceInfo, resolveSettingsPages } from '../../shared/settings/resolvePages'
import { pageMatches, searchPages } from '../../shared/settings/search'

const DEFAULTS = { reopenLast: true, recentLimit: 10, name: 'Home', sort: 'name', matching: { days: 14 } }

describe('settings fields: definitions', () => {
  it('accepts each kind of field whose default suits it', () => {
    expect(fieldDefinitionProblem({ kind: 'boolean', key: 'reopenLast', label: 'Reopen' }, DEFAULTS)).toBeUndefined()
    expect(fieldDefinitionProblem({ kind: 'number', key: 'matching.days', label: 'Days', min: 0, max: 60, integer: true, unit: 'days' }, DEFAULTS)).toBeUndefined()
    expect(fieldDefinitionProblem({ kind: 'text', key: 'name', label: 'Name', required: true, maxLength: 40 }, DEFAULTS)).toBeUndefined()
    expect(fieldDefinitionProblem({ kind: 'choice', key: 'sort', label: 'Sort', options: [{ value: 'name', label: 'Name' }, { value: 'date', label: 'Date' }] }, DEFAULTS)).toBeUndefined()
  })

  it('refuses a field it could not edit, saying why', () => {
    const problem = (field: unknown) => fieldDefinitionProblem(field, DEFAULTS)
    expect(problem('x')).toBe('a field is not an object')
    expect(problem({ kind: 'boolean', key: '__proto__', label: 'X' })).toBe('a field has an invalid key "__proto__"')
    expect(problem({ kind: 'boolean', key: 'reopenLast' })).toBe('field "reopenLast" is missing a label')
    expect(problem({ kind: 'slider', key: 'recentLimit', label: 'X' })).toBe('field "recentLimit" has an unknown kind "slider"; use boolean, number, text, choice')
    expect(problem({ kind: 'boolean', key: 'missing', label: 'X' })).toBe('field "missing" has no default: the namespace\'s defaults have no "missing"')
    expect(problem({ kind: 'boolean', key: 'recentLimit', label: 'X' })).toBe('field "recentLimit" is a checkbox, but its default is not true or false')
    expect(problem({ kind: 'number', key: 'name', label: 'X' })).toBe('field "name" is a number, but its default is not a number')
    expect(problem({ kind: 'number', key: 'recentLimit', label: 'X', min: 5, max: 1 })).toBe('field "recentLimit" has a min above its max')
    expect(problem({ kind: 'text', key: 'recentLimit', label: 'X' })).toBe('field "recentLimit" is text, but its default is not a string')
    expect(problem({ kind: 'text', key: 'name', label: 'X', maxLength: 0 })).toBe('field "name" has an invalid maxLength')
    expect(problem({ kind: 'choice', key: 'sort', label: 'X', options: [] })).toBe('field "sort" is a choice with no options')
    expect(problem({ kind: 'choice', key: 'sort', label: 'X', options: [{ value: 'date', label: 'Date' }] })).toBe('field "sort" has a default that is not one of its options')
    expect(problem({ kind: 'choice', key: 'sort', label: 'X', options: [{ value: 'name', label: 'A' }, { value: 'name', label: 'B' }] })).toBe('field "sort" has the option "name" twice')
    expect(problem({ kind: 'choice', key: 'sort', label: 'X', options: [{ value: {}, label: 'A' }] })).toBe('field "sort" has an option without a label and a string or number value')
    expect(problem({ kind: 'choice', key: 'sort', label: 'X', options: [{ value: 'name', label: 'A', description: 3 }] })).toBe('field "sort" has an option with an invalid description')
  })
})

describe('settings fields: values', () => {
  const limit: SettingsField = { kind: 'number', key: 'recentLimit', label: 'Recent ledgers', min: 1, max: 30, integer: true }

  it('checks numbers against their range and whole-number rule', () => {
    expect(fieldValueProblem(limit, 10)).toBeUndefined()
    expect(fieldValueProblem(limit, 0)).toBe('Recent ledgers: enter a number from 1 to 30.')
    expect(fieldValueProblem(limit, 2.5)).toBe('Recent ledgers: enter a whole number.')
    expect(fieldValueProblem(limit, '3')).toBe('Recent ledgers: enter a number.')
    expect(fieldValueProblem({ ...limit, max: undefined }, 0)).toBe('Recent ledgers: enter 1 or more.')
    expect(fieldValueProblem({ ...limit, min: undefined }, 31)).toBe('Recent ledgers: enter 30 or less.')
  })

  it('checks text, choices and checkboxes', () => {
    expect(fieldValueProblem({ kind: 'text', key: 'name', label: 'Name', required: true }, '  ')).toBe("Name: this can't be empty.")
    expect(fieldValueProblem({ kind: 'text', key: 'name', label: 'Name', maxLength: 3 }, 'four')).toBe('Name: use at most 3 characters.')
    expect(fieldValueProblem({ kind: 'choice', key: 'sort', label: 'Sort', options: [{ value: 'name', label: 'Name' }, { value: 'date', label: 'Date' }] }, 'size'))
      .toBe('Sort: choose one of Name, Date.')
    expect(fieldValueProblem({ kind: 'boolean', key: 'reopenLast', label: 'Reopen' }, 'yes')).toBe('Reopen: choose on or off.')
  })

  it('lists every problem in a value, in field order', () => {
    expect(fieldsProblems([limit, { kind: 'text', key: 'name', label: 'Name', required: true }], { recentLimit: 0, name: '' }))
      .toEqual(['Recent ledgers: enter a number from 1 to 30.', "Name: this can't be empty."])
  })
})

const namespaces: Record<string, NamespaceInfo> = {
  ledger: { owner: 'ledger', defaults: DEFAULTS },
  'ledger.display': { owner: 'ledger', defaults: { compact: false } },
  accounts: { owner: 'accounts', defaults: { showClosed: false } }
}
const namespaceOf = (id: string) => namespaces[id]
const from = (contributor: string, impl: unknown) => ({ contributor, impl })
const reopen = { kind: 'boolean', key: 'reopenLast', label: 'Reopen the last ledger' }

describe('resolveSettingsPages', () => {
  it('resolves a page of fields for the contributor\'s own settings, copying only what a field has', () => {
    const { pages, diagnostics } = resolveSettingsPages([
      from('ledger', { id: 'ledger.settings', title: 'Ledger', fields: [{ ...reopen, extra: 'dropped' }], keywords: ['start-up'], description: 'Files' })
    ], namespaceOf)

    expect(diagnostics).toEqual([])
    expect(pages).toEqual([{
      id: 'ledger.settings', title: 'Ledger', pluginId: 'ledger', settings: 'ledger', description: 'Files', keywords: ['start-up'],
      fields: [{ kind: 'boolean', key: 'reopenLast', label: 'Reopen the last ledger' }]
    }])
  })

  it('keeps what each option of a choice means, and nothing else of it', () => {
    const { pages } = resolveSettingsPages([from('ledger', {
      id: 'ledger.order', title: 'Order',
      fields: [{ kind: 'choice', key: 'sort', label: 'Sort', options: [{ value: 'name', label: 'Name', description: 'A to Z', colour: 'red' }, { value: 'date', label: 'Date' }] }]
    })], namespaceOf)
    expect(pages[0].fields).toEqual([{ kind: 'choice', key: 'sort', label: 'Sort', options: [{ value: 'name', label: 'Name', description: 'A to Z' }, { value: 'date', label: 'Date' }] }])
  })

  it('resolves a page with its own component, editing a named namespace, and a category without either', () => {
    const { pages, diagnostics } = resolveSettingsPages([
      from('ledger', { id: 'ledger.display', title: 'Display', module: './DisplayPage', settings: 'ledger.display', parent: 'ledger.root' }),
      from('ledger', { id: 'ledger.root', title: 'Ledger' })
    ], namespaceOf)

    expect(diagnostics).toEqual([])
    expect(pages).toEqual([
      { id: 'ledger.root', title: 'Ledger', pluginId: 'ledger', keywords: [] },
      { id: 'ledger.display', title: 'Display', pluginId: 'ledger', parent: 'ledger.root', settings: 'ledger.display', module: './DisplayPage', keywords: [] }
    ])
  })

  it('lists pages in tree order: each followed by its children, siblings by order then registration', () => {
    const page = (id: string, extra: object = {}) => from(id.split('.')[0], { id, title: id, ...extra })
    const { pages } = resolveSettingsPages([
      page('ledger.b', { order: 2 }),
      page('accounts.child', { parent: 'ledger.a' }),
      page('ledger.a', { order: 1 }),
      page('ledger.c', { order: 2 }),
      page('ledger.first-child', { parent: 'ledger.a', order: -1 })
    ], namespaceOf)

    expect(pages.map(p => p.id)).toEqual(['ledger.a', 'ledger.first-child', 'accounts.child', 'ledger.b', 'ledger.c'])
  })

  it('refuses pages that are not their contributor\'s, or edit settings it does not own or nobody registered', () => {
    const { pages, diagnostics } = resolveSettingsPages([
      from('evil', { id: 'ledger.settings', title: 'Gotcha', fields: [reopen] }),
      from('evil', { id: 'evil.settings', title: 'Gotcha', fields: [reopen], settings: 'ledger' }),
      from('accounts', { id: 'accounts.other', title: 'Other', fields: [reopen], settings: 'accounts.other' }),
      from('budget', { id: 'budget.settings', title: 'Budget', fields: [reopen] })
    ], namespaceOf)

    expect(pages).toEqual([])
    expect(diagnostics).toEqual([
      'Settings page "ledger.settings" ignored: its id must start with "evil."',
      'Settings page "evil.settings" ignored: it may only edit "evil" settings, not "ledger"',
      'Settings page "accounts.other" ignored: settings "accounts.other" are not registered',
      'Settings page "budget.settings" ignored: settings "budget" are not registered'
    ])
  })

  it('refuses malformed pages, saying what is wrong', () => {
    const { pages, diagnostics } = resolveSettingsPages([
      from('ledger', null),
      from('ledger', { title: 'No id' }),
      from('ledger', { id: 'ledger.a' }),
      from('ledger', { id: 'ledger.b', title: 'B', module: './B', fields: [reopen] }),
      from('ledger', { id: 'ledger.c', title: 'C', module: 'C' }),
      from('ledger', { id: 'ledger.d', title: 'D', settings: 'ledger' }),
      from('ledger', { id: 'ledger.e', title: 'E', keywords: 'start' }),
      from('ledger', { id: 'ledger.f', title: 'F', order: 'first' }),
      from('ledger', { id: 'ledger.g', title: 'G', fields: {} })
    ], namespaceOf)

    expect(pages).toEqual([])
    expect(diagnostics).toEqual([
      'Settings page contribution is not an object',
      'Settings page contribution is missing an id',
      'Settings page "ledger.a" is missing a title',
      'Settings page "ledger.b" has both a module and fields; use one',
      'Settings page "ledger.c" must name an exposed module like "./MySettingsPage"',
      'Settings page "ledger.d" names settings but has no module or fields to edit them with',
      'Settings page "ledger.e" has invalid keywords; use a list of words',
      'Settings page "ledger.f" has an invalid order',
      'Settings page "ledger.g" has fields that are not a list'
    ])
  })

  it('leaves out fields that do not suit the settings, and a page left with none', () => {
    const { pages, diagnostics } = resolveSettingsPages([
      from('ledger', { id: 'ledger.settings', title: 'Ledger', fields: [reopen, { kind: 'number', key: 'nope', label: 'Nope' }, reopen] }),
      from('ledger', { id: 'ledger.empty', title: 'Empty', fields: [{ kind: 'number', key: 'name', label: 'Name' }] })
    ], namespaceOf)

    expect(pages.map(p => [p.id, p.fields?.map(f => f.key)])).toEqual([['ledger.settings', ['reopenLast']]])
    expect(diagnostics).toEqual([
      'Settings page "ledger.settings": field "nope" has no default: the namespace\'s defaults have no "nope"; the field is left out',
      'Settings page "ledger.settings": field "reopenLast" appears twice; the second is left out',
      'Settings page "ledger.empty": field "name" is a number, but its default is not a number; the field is left out',
      'Settings page "ledger.empty" ignored: it has no usable fields'
    ])
  })

  it('keeps the first of two pages with one id', () => {
    const { pages, diagnostics } = resolveSettingsPages([
      from('ledger', { id: 'ledger.settings', title: 'First' }),
      from('ledger', { id: 'ledger.settings', title: 'Second' })
    ], namespaceOf)
    expect(pages.map(p => p.title)).toEqual(['First'])
    expect(diagnostics).toEqual(['Duplicate settings page id "ledger.settings" ignored'])
  })

  it('shows a page with an unknown parent, or in a cycle of parents, at the top level', () => {
    const { pages, diagnostics } = resolveSettingsPages([
      from('ledger', { id: 'ledger.orphan', title: 'Orphan', parent: 'ledger.gone' }),
      from('ledger', { id: 'ledger.self', title: 'Self', parent: 'ledger.self' }),
      from('ledger', { id: 'ledger.a', title: 'A', parent: 'ledger.b' }),
      from('ledger', { id: 'ledger.b', title: 'B', parent: 'ledger.a' }),
      from('ledger', { id: 'ledger.under', title: 'Under', parent: 'ledger.a' })
    ], namespaceOf)

    expect(pages.map(p => [p.id, p.parent])).toEqual([
      ['ledger.orphan', undefined], ['ledger.self', undefined], ['ledger.a', undefined],
      ['ledger.b', 'ledger.a'], ['ledger.under', 'ledger.a']
    ])
    expect(diagnostics).toEqual([
      'Settings page "ledger.orphan" names an unknown parent "ledger.gone"; it is shown at the top level',
      'Settings page "ledger.self" is part of a cycle of parents; it is shown at the top level',
      'Settings page "ledger.a" is part of a cycle of parents; it is shown at the top level'
    ])
  })
})

describe('settings search', () => {
  const { pages } = resolveSettingsPages([
    from('ledger', { id: 'ledger.root', title: 'Ledger' }),
    from('ledger', { id: 'ledger.settings', title: 'Files', parent: 'ledger.root', keywords: ['start-up'], fields: [{ ...reopen, description: 'Instead of the start page' }] }),
    from('accounts', { id: 'accounts.settings', title: 'Accounts', description: 'How balances are shown', fields: [{ kind: 'boolean', key: 'showClosed', label: 'Show closed accounts' }] })
  ], namespaceOf)

  it('finds a page by its title, description, keywords and fields, every word, in any case', () => {
    const found = (query: string) => pages.filter(page => pageMatches(page, query)).map(page => page.id)
    expect(found('')).toEqual(['ledger.root', 'ledger.settings', 'accounts.settings'])
    expect(found('BALANCES')).toEqual(['accounts.settings'])
    expect(found('start-up')).toEqual(['ledger.settings'])
    expect(found('start page')).toEqual(['ledger.settings'])
    expect(found('closed accounts')).toEqual(['accounts.settings'])
    expect(found('closed ledger')).toEqual([])
  })

  it('finds a page by the options of its choices, and what they mean', () => {
    const { pages: withChoice } = resolveSettingsPages([from('ledger', {
      id: 'ledger.order', title: 'Order',
      fields: [{ kind: 'choice', key: 'sort', label: 'Sort', options: [{ value: 'name', label: 'Alphabetical', description: 'Ignoring accents' }, { value: 'date', label: 'Date' }] }]
    })], namespaceOf)
    expect(pageMatches(withChoice[0], 'alphabetical')).toBe(true)
    expect(pageMatches(withChoice[0], 'accents')).toBe(true)
  })

  it('shows the pages above a page it finds', () => {
    const { shown, matched } = searchPages(pages, 'reopen')
    expect([...matched]).toEqual(['ledger.settings'])
    expect([...shown].sort()).toEqual(['ledger.root', 'ledger.settings'])
  })
})
