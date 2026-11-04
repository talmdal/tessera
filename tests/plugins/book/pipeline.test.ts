// @vitest-environment node
// The book plugin as built and loaded by the app: bundled, discovered on disk, activated after its providers.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { BOOK_SESSION_SERVICE, type BookSession } from '@tessera/book-api'
import { createPluginRuntime } from '../../../core/plugins/PluginContext'
import { PluginManager } from '../../../core/plugins/PluginManager'
import { buildPlugins } from '../../../scripts/build-plugins.mts'
import { defaultBootstrapConfig, toPluginSelection } from '../../../shell/main/bootstrap/bootstrapConfig'
import { FsPluginSource } from '../../../shell/main/plugins/FsPluginSource'
import { createLogger } from '../../helpers/runtime'
import { createTempModulesDir } from '../../helpers/tempModules'

const repo = path.resolve(__dirname, '../../..')
// Inside the repository, as the app's modules/ folder is, so external packages resolve
const scratch = fs.mkdtempSync(path.join(fs.mkdirSync(path.join(repo, 'node_modules/.cache'), { recursive: true }) ?? path.join(repo, 'node_modules/.cache'), 'tessera-book-'))
afterAll(() => { fs.rmSync(scratch, { recursive: true, force: true }) })

describe('the built book plugin', () => {
  it('activates after storage and app state, and keeps a book in a real SQLite file', { timeout: 120_000 }, async () => {
    const out = path.join(scratch, 'modules')
    const results = await buildPlugins({ pluginsDir: path.join(repo, 'plugins'), outDir: out, only: ['storage.sqlite', 'storage.loki', 'app.state', 'book'] })
    expect(results.every(r => r.ok)).toBe(true)

    const userData = createTempModulesDir()
    const log = createLogger()
    const runtime = createPluginRuntime(userData, log)
    // The shell's services, as app.ts provides them before plugins activate
    runtime.services.provide('shell', SHELL_FILES_SERVICE, {
      showOpenDialog: async () => undefined, showSaveDialog: async () => undefined,
      exists: async (f: string) => fs.existsSync(f), trash: vi.fn(async () => {}), documentsPath: () => userData
    })
    runtime.services.provide('shell', SHELL_PROMPTS_SERVICE, { confirm: async () => true, message: async () => {}, prompt: async () => undefined, show: async () => undefined })

    const manager = new PluginManager(new FsPluginSource([{ dir: out, origin: 'bundled' }], log), runtime, log, toPluginSelection(defaultBootstrapConfig()))
    const active = (await manager.activateAll()).map(manifest => manifest.id)
    expect(active).toContain('book')
    expect(active.indexOf('book')).toBeGreaterThan(active.indexOf('app-state'))
    expect(runtime.services.providerOf('storage.engine')).toBe('storage-sqlite')

    const session = runtime.services.get<BookSession>(BOOK_SESSION_SERVICE)
    const file = path.join(userData, 'Home.tessera')
    await session.create(file)
    await session.createSubBook({ name: 'Personal', parentId: null })
    await manager.deactivateAll()

    expect(fs.readFileSync(file).subarray(0, 15).toString('latin1')).toBe('SQLite format 3')

    // A second run of the app reopens it with its sub-book
    const again = createPluginRuntime(userData, log)
    again.services.provide('shell', SHELL_FILES_SERVICE, runtime.services.get(SHELL_FILES_SERVICE))
    again.services.provide('shell', SHELL_PROMPTS_SERVICE, runtime.services.get(SHELL_PROMPTS_SERVICE))
    const second = new PluginManager(new FsPluginSource([{ dir: out, origin: 'bundled' }], log), again, log, toPluginSelection(defaultBootstrapConfig()))
    await second.activateAll()
    await again.lifecycle.markStarted()
    const reopened = again.services.get<BookSession>(BOOK_SESSION_SERVICE)
    expect(reopened.current?.name).toBe('Home')
    expect((await reopened.tree()).subBooks.map(s => s.name)).toEqual(['Personal'])
    await second.deactivateAll()
    expect(log.error).not.toHaveBeenCalled()
  })
})
