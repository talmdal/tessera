// @vitest-environment node
// The accounts plugin as built and loaded by the app, beside the book, the SQLite engine and app state.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { BOOK_SESSION_SERVICE, type BookSession } from '@tessera/book-api'
import { ACCOUNTS_SERVICE, type AccountsService } from '@tessera/accounts-api'
import { createPluginRuntime } from '../../../core/plugins/PluginContext'
import { PluginManager } from '../../../core/plugins/PluginManager'
import { buildPlugins } from '../../../scripts/build-plugins.mts'
import { defaultBootstrapConfig, toPluginSelection } from '../../../shell/main/bootstrap/bootstrapConfig'
import { FsPluginSource } from '../../../shell/main/plugins/FsPluginSource'
import { createLogger } from '../../helpers/runtime'
import { createTempModulesDir } from '../../helpers/tempModules'

const repo = path.resolve(__dirname, '../../..')
const scratch = fs.mkdtempSync(path.join(fs.mkdirSync(path.join(repo, 'node_modules/.cache'), { recursive: true }) ?? path.join(repo, 'node_modules/.cache'), 'tessera-accounts-'))
afterAll(() => { fs.rmSync(scratch, { recursive: true, force: true }) })

describe('the built accounts plugin', () => {
  it('keeps accounts and their transactions in the book\'s SQLite file, across runs of the app', { timeout: 180_000 }, async () => {
    const out = path.join(scratch, 'modules')
    const results = await buildPlugins({ pluginsDir: path.join(repo, 'plugins'), outDir: out, only: ['storage.sqlite', 'app.state', 'book', 'accounts'] })
    expect(results.every(r => r.ok), JSON.stringify(results)).toBe(true)

    const userData = createTempModulesDir()
    const log = createLogger()
    const shellServices = {
      files: { showOpenDialog: async () => undefined, showSaveDialog: async () => undefined, exists: async (f: string) => fs.existsSync(f), trash: vi.fn(async () => {}), documentsPath: () => userData },
      prompts: { confirm: async () => true, message: async () => {}, prompt: async () => undefined, show: async () => undefined }
    }
    const start = async () => {
      const runtime = createPluginRuntime(userData, log)
      runtime.services.provide('shell', SHELL_FILES_SERVICE, shellServices.files)
      runtime.services.provide('shell', SHELL_PROMPTS_SERVICE, shellServices.prompts)
      const manager = new PluginManager(new FsPluginSource([{ dir: out, origin: 'bundled' }], log), runtime, log, toPluginSelection(defaultBootstrapConfig()))
      const active = (await manager.activateAll()).map(m => m.id)
      await runtime.lifecycle.markStarted()
      return {
        active, manager,
        session: runtime.services.get<BookSession>(BOOK_SESSION_SERVICE),
        accounts: runtime.services.get<AccountsService>(ACCOUNTS_SERVICE)
      }
    }

    const first = await start()
    expect(first.active.indexOf('accounts')).toBeGreaterThan(first.active.indexOf('book'))
    await first.session.create(path.join(userData, 'Home.tessera'))
    const business = await first.session.createSubBook({ name: 'Business', parentId: null })
    const chequing = await first.accounts.createAccount({ name: 'Chequing', type: 'chequing', subBookId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 100000 })
    const visa = await first.accounts.createAccount({ name: 'Visa', type: 'creditCard', subBookId: business.id, currency: 'CAD', openingDate: '2026-01-01', openingBalance: -54000, creditLimit: 500000 })
    await first.session.deleteSubBook(business.id)       // the card moves up to the book
    const groceries = (await first.accounts.categories.list()).find(c => c.name === 'Groceries')!
    await first.accounts.transactions(chequing.id).create({ date: '2026-10-02', amount: -5025, payee: 'Metro', categoryId: groceries.id })
    await first.accounts.transactions(chequing.id).create({ date: '2026-10-03', amount: -20000, payee: 'Visa payment', transferAccountId: visa.id })
    await first.manager.deactivateAll()

    const second = await start()
    expect(second.session.current?.name).toBe('Home')
    expect((await second.accounts.list()).map(a => [a.name, a.subBookId, a.openingBalance])).toEqual([['Chequing', null, 100000], ['Visa', null, -54000]])
    // The transfer paid the card down; the groceries are spent
    expect((await second.accounts.balances(chequing.id)).current).toBe(100000 - 5025 - 20000)
    expect((await second.accounts.balances(visa.id)).current).toBe(-54000 + 20000)
    expect((await second.accounts.transactions(chequing.id).register()).rows.map(r => r.categoryLabel)).toEqual(['Food : Groceries', 'Transfer to: Visa'])
    expect((await second.accounts.chart()).totals).toEqual({ CAD: 46000 - 5025 })
    await second.manager.deactivateAll()
    expect(log.error).not.toHaveBeenCalled()
  })
})
