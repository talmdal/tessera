// The Problems display, from the main process's side: what it contributes, what it answers, and that the trouble
// a user would otherwise never see — a plugin skipped at startup, a failing command — ends up in it.
import { describe, expect, it, vi } from 'vitest'
import type { ShellPrompts } from '@tessera/types'
import { DIALOGS_EXTENSION_POINT, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { BAR_ITEMS_EXTENSION_POINT } from '../../shared/layout/types'
import { createPluginContext, createPluginRuntime } from '../../core/plugins/PluginContext'
import { PluginManager } from '../../core/plugins/PluginManager'
import { ProblemLog, recordingLogger } from '../../core/problems/ProblemLog'
import { resolveBarItems } from '../../shared/layout/resolveBarItems'
import { MENUS_EXTENSION_POINT } from '../../shared/menus/types'
import { SHELL_CONTRIBUTOR_ID } from '../../shared/plugins/manifest'
import {
  PROBLEMS_CHANGED, PROBLEMS_CLEAR, PROBLEMS_COMMANDS, PROBLEMS_DIALOG, PROBLEMS_KEYS, PROBLEMS_LIST, PROBLEMS_REPORT,
  REPORT_LIMIT, type ProblemEntry
} from '../../shared/problems/types'
import { registerCommandsIpc } from '../../shell/main/commands/commandsIpc'
import { registerProblems } from '../../shell/main/problems/registerProblems'
import { COMMANDS_EXECUTE } from '../../shared/shellEvents'
import { manifest, MemoryPluginSource } from '../helpers/runtime'

function setup() {
  const queued: (() => void)[] = []
  const problems = new ProblemLog({ defer: work => { queued.push(work) } })
  const settle = () => { for (const work of queued.splice(0)) work() }
  const console = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const log = recordingLogger(console, problems)
  const runtime = createPluginRuntime(undefined, log)
  const shell = createPluginContext(SHELL_CONTRIBUTOR_ID, runtime).context
  const prompts = { show: vi.fn(async () => undefined) } as unknown as ShellPrompts
  runtime.services.provide(SHELL_CONTRIBUTOR_ID, SHELL_PROMPTS_SERVICE, prompts)
  registerProblems(shell, runtime, problems)

  const published: { name: string, data?: unknown }[] = []
  runtime.events.subscribe(event => { published.push(event) })
  const ask = async (channel: string, data?: unknown, windowId?: number) => {
    const reply = await runtime.ipc.dispatch({ channel, data }, windowId === undefined ? undefined : { windowId })
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.data
  }
  return { runtime, shell, problems, log, prompts, settle, published, ask }
}

describe('what the shell contributes', () => {
  it('a status bar count that the layout accepts, shown only while there are problems', () => {
    const { runtime } = setup()
    const { items, diagnostics } = resolveBarItems(runtime.extensions.getContributions(BAR_ITEMS_EXTENSION_POINT))
    expect(diagnostics).toEqual([])
    expect(items.find(item => item.id === 'shell.status.problems')).toMatchObject({
      kind: 'text', slot: 'shell.bottom', when: PROBLEMS_KEYS.count, command: PROBLEMS_COMMANDS.show
    })
  })

  it('the Problems dialog, and a Help menu item that opens it', () => {
    const { runtime } = setup()
    expect(runtime.extensions.getContributions(DIALOGS_EXTENSION_POINT).map(c => (c.impl as { id: string }).id)).toContain(PROBLEMS_DIALOG)
    expect(runtime.extensions.getContributions(MENUS_EXTENSION_POINT).map(c => c.impl))
      .toContainEqual(expect.objectContaining({ kind: 'item', command: PROBLEMS_COMMANDS.show }))
  })

  it('opens the dialog from its command', async () => {
    const { runtime, prompts } = setup()
    await runtime.commands.execute(PROBLEMS_COMMANDS.show)
    expect(prompts.show).toHaveBeenCalledWith(PROBLEMS_DIALOG)
  })
})

describe('keeping the user informed', () => {
  it('counts problems in a context key, unset while there are none', () => {
    const { runtime, log, settle } = setup()
    expect(runtime.contextKeys.get(PROBLEMS_KEYS.count)).toBeUndefined()

    log.warn('[views] View "x" ignored')
    log.error('[plugins] Failed to activate "y"', new Error('nope'))
    settle()
    expect(runtime.contextKeys.get(PROBLEMS_KEYS.count)).toBe(2)
    expect(runtime.contextKeys.get(PROBLEMS_KEYS.errors)).toBe(1)
  })

  it('tells the windows when the list changes', () => {
    const { log, settle, published } = setup()
    log.warn('[views] View "x" ignored')
    settle()
    expect(published).toContainEqual({ name: PROBLEMS_CHANGED, data: { total: 1, errors: 0, warnings: 1 } })
  })

  it('lists them, and clears them', async () => {
    const { log, ask, settle, runtime } = setup()
    log.warn('[views] View "x" ignored')
    expect((await ask(PROBLEMS_LIST) as ProblemEntry[]).map(p => p.message)).toEqual(['View "x" ignored'])

    await ask(PROBLEMS_CLEAR)
    settle()
    expect(await ask(PROBLEMS_LIST)).toEqual([])
    expect(runtime.contextKeys.get(PROBLEMS_KEYS.count)).toBeUndefined()
  })

  it('counts what was logged before it was registered', () => {
    const problems = new ProblemLog({ defer: () => {} })
    problems.record('warning', '[options] Could not read the options file')
    const runtime = createPluginRuntime(undefined, recordingLogger({ info() {}, warn() {}, error() {} }, problems))
    const shell = createPluginContext(SHELL_CONTRIBUTOR_ID, runtime).context
    registerProblems(shell, runtime, problems)
    expect(runtime.contextKeys.get(PROBLEMS_KEYS.count)).toBe(1)
  })
})

describe('what ends up in it', () => {
  it('a plugin skipped at startup because a service it needs is missing', async () => {
    const { runtime, log, ask } = setup()
    const source = new MemoryPluginSource([{
      location: '/modules/budget',
      manifest: manifest('budget', { services: { requires: ['ledger.session'] } }),
      module: { activate: () => {} }
    }])
    await new PluginManager(source, runtime, log).activateAll()

    const listed = await ask(PROBLEMS_LIST) as ProblemEntry[]
    expect(listed).toContainEqual(expect.objectContaining({
      level: 'warning', source: 'plugins', message: expect.stringContaining('requires service "ledger.session", which no plugin provides')
    }))
  })

  it('a command a window ran that failed, even when the window ignores the failure', async () => {
    const { runtime, shell, log, ask } = setup()
    registerCommandsIpc(shell, log)
    runtime.commands.register('test.broken', () => { throw new Error('it broke') })

    await expect(ask(COMMANDS_EXECUTE, { id: 'test.broken' })).rejects.toThrow('it broke')
    const listed = await ask(PROBLEMS_LIST) as ProblemEntry[]
    expect(listed).toContainEqual(expect.objectContaining({
      level: 'error', source: 'ipc', message: 'Handler for shell:commands.execute failed: it broke', detail: expect.stringContaining('it broke')
    }))
  })

  it('an error a window reported, naming the window', async () => {
    const { ask } = setup()
    await ask(PROBLEMS_REPORT, { message: 'Uncaught error: x is undefined', detail: 'at View.tsx:3' }, 2)
    expect(await ask(PROBLEMS_LIST)).toEqual([expect.objectContaining({
      level: 'error', source: 'window 2', message: 'Uncaught error: x is undefined', detail: 'at View.tsx:3'
    })])
  })

  it('a window’s report, clipped, and ignored when it is not a report at all', async () => {
    const { ask } = setup()
    await ask(PROBLEMS_REPORT, 'nonsense')
    await ask(PROBLEMS_REPORT, { level: 'warning', message: 'x'.repeat(REPORT_LIMIT * 2) })
    const listed = await ask(PROBLEMS_LIST) as ProblemEntry[]
    expect(listed).toHaveLength(1)
    expect(listed[0].level).toBe('warning')
    expect(listed[0].message.length).toBeLessThanOrEqual(REPORT_LIMIT + 1)
  })
})
