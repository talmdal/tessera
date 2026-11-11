// @vitest-environment node
// The import's settings: the matching preset, chosen on the Options dialog's Import page, as the app runs it. A user has
// typed some of October's transactions, and the bank's October statement is imported under each preset.
import { describe, expect, it } from 'vitest'
import { IMPORT_SETTINGS_PAGE } from '@tessera/import-api'
import { FIT, typedThenImported } from './typed'
import type { ImportEnv } from './harness'

const choose = (env: ImportEnv, matching: unknown) => env.runtime.settings.commit([{ id: 'import', value: { matching } }])

describe('the import\'s settings page', () => {
  it('offers the presets as one choice, each explained, on a page the shell draws', async () => {
    const { env } = await typedThenImported()
    const page = env.runtime.settings.pages().find(p => p.id === IMPORT_SETTINGS_PAGE)!

    expect(page).toMatchObject({ title: 'Import', settings: 'import' })
    expect(page.fields).toHaveLength(1)
    const [field] = page.fields!
    expect(field.kind === 'choice' && field.options.map(o => [o.value, o.label, typeof o.description])).toEqual([
      ['strict', 'Strict', 'string'], ['balanced', 'Balanced (recommended)', 'string'], ['lenient', 'Lenient', 'string']
    ])
    expect(env.runtime.settings.snapshot('import')?.value).toEqual({ matching: 'balanced' })
    expect(env.log.warn.mock.calls.filter(c => String(c[0]).includes('[settings]'))).toEqual([])
  })

  it('takes only a preset: there is no number to change', async () => {
    const { env } = await typedThenImported()
    expect(await choose(env, 'wild')).toEqual({
      ok: false,
      errors: { import: ['Matching: choose one of Strict, Balanced (recommended), Lenient.', 'Choose one of strict, balanced, lenient.'] }
    })
    expect(await choose(env, 0.5)).toMatchObject({ ok: false })
  })
})

/**
 * The user's entry for the statement's Loblaws line: a day early, 37 cents short, under a longer name, so it scores
 * 0.8775: proposed by every preset, *Matched* under Balanced (0.85) but a *Possible match* under Strict (0.9).
 */
const typeLoblaws = async (env: ImportEnv, accountId: string) =>
  (await env.accounts.transactions(accountId).create({ date: '2026-10-14', amount: -14250, payee: 'Loblaws Great Food' })).id

describe('importing under each preset', () => {
  it('Balanced (the default) proposes the tip, and is sure of the groceries', async () => {
    let loblaws = ''
    const { report, line, entered, mark } = await typedThenImported({ beforeImport: async (env, id) => { loblaws = await typeLoblaws(env, id) } })
    expect(report!.results[0].counts).toMatchObject({ matched: 5, possible: 2 })
    expect((await line(FIT.keg)).proposedId).toBe(entered.keg.id)
    expect((await mark(loblaws))?.tone).toBe('info')
  })

  it('Strict leaves the tip for the user to match, and shows the groceries as a possible match only', async () => {
    let loblaws = ''
    const { report, line, mark } = await typedThenImported({
      beforeImport: async (env, id) => { loblaws = await typeLoblaws(env, id); await choose(env, 'strict') }
    })
    expect(await line(FIT.keg)).toMatchObject({ outcome: 'added' })
    expect((await line(FIT.loblaws)).proposedId).toBe(loblaws)
    expect(report!.results[0].counts).toMatchObject({ matched: 4, possible: 2 })
    expect((await mark(loblaws))?.tone).toBe('warning')
  })

  it('Lenient proposes at least everything Balanced does', async () => {
    const balanced = await typedThenImported()
    const lenient = await typedThenImported({ beforeImport: env => choose(env, 'lenient').then(() => {}) })
    for (const key of Object.keys(FIT) as (keyof typeof FIT)[]) {
      const proposed = (await balanced.line(FIT[key]))?.proposedId !== undefined
      if (proposed) expect((await lenient.line(FIT[key])).proposedId, key).toBeDefined()
    }
  })

  it('re-scores proposals still to review when the preset changes, and tells their registers', async () => {
    let loblaws = ''
    const { env, account, mark, annotator } = await typedThenImported({ beforeImport: async (env, id) => { loblaws = await typeLoblaws(env, id) } })
    const heard: string[][] = []
    annotator.onDidChange(change => heard.push(change.accounts))
    expect((await mark(loblaws))?.tone).toBe('info')

    await choose(env, 'strict')

    await expect.poll(() => heard).toEqual([[account.id]])
    expect((await mark(loblaws))?.tone).toBe('warning')
    await choose(env, 'balanced')
    expect((await mark(loblaws))?.tone).toBe('info')
  })
})
