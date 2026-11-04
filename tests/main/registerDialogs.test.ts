import { describe, expect, it, vi } from 'vitest'
import type { PluginContext, ShellFiles, ShellPrompts } from '@tessera/types'
import { DIALOGS_EXTENSION_POINT, SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { DialogService } from '../../core/dialogs/DialogService'
import { createPluginContext, createPluginRuntime } from '../../core/plugins/PluginContext'
import { PluginManager } from '../../core/plugins/PluginManager'
import { DIALOG_CLOSE, DIALOG_OPEN, DialogOpen, PROMPT_DIALOG } from '../../shared/dialogs/types'
import { SHELL_CONTRIBUTOR_ID } from '../../shared/plugins/manifest'
import { createElectronPrompts } from '../../shell/main/dialogs/electronPrompts'
import { registerDialogs } from '../../shell/main/dialogs/registerDialogs'
import { registerWindowReady } from '../../shell/main/window/windowReveal'
import { createLogger, manifest, MemoryPluginSource } from '../helpers/runtime'
import { WINDOW_READY } from '../../shared/shellEvents'

function setup() {
  const log = createLogger()
  const runtime = createPluginRuntime(undefined, log)
  const shell = createPluginContext(SHELL_CONTRIBUTOR_ID, runtime).context
  const dialogs = new DialogService(runtime.extensions, runtime.events, {
    remoteEntryFor: id => `tessera-plugin://${id}/remoteEntry.js`, targetWindow: () => 1, log
  })
  const platform = {
    dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
    BrowserWindow: { getFocusedWindow: () => null, fromId: () => null }
  }
  const files: ShellFiles = {
    showOpenDialog: vi.fn(async () => undefined), showSaveDialog: vi.fn(async () => '/tmp/x.tessera'),
    exists: vi.fn(async () => true), trash: vi.fn(async () => {}), documentsPath: () => '/docs'
  }
  const reveal = { rendererReady: vi.fn() }
  registerWindowReady(shell, reveal, dialogs)
  registerDialogs(shell, runtime, dialogs, { prompts: createElectronPrompts(platform, dialogs), files })

  const sent: DialogOpen[] = []
  runtime.events.subscribe(event => { if (event.name === DIALOG_OPEN) sent.push(event.data as DialogOpen) })
  const ask = (channel: string, data?: unknown, windowId?: number) =>
    runtime.ipc.dispatch({ channel, data }, windowId === undefined ? undefined : { windowId })
  return { runtime, dialogs, files, sent, ask, log, reveal }
}

describe('registerDialogs', () => {
  it('provides shell.prompts and shell.files as shell services, before any plugin activates', () => {
    const { runtime, files } = setup()
    expect(runtime.services.providerOf(SHELL_PROMPTS_SERVICE)).toBe('shell')
    expect(runtime.services.providerOf(SHELL_FILES_SERVICE)).toBe('shell')
    expect(runtime.services.get(SHELL_FILES_SERVICE)).toBe(files)
  })

  it('lets a plugin require both services and use them from activate', async () => {
    const { runtime, log } = setup()
    let seen: { prompts?: ShellPrompts, files?: ShellFiles } = {}
    const source = new MemoryPluginSource([{
      location: '/book',
      manifest: manifest('book', { services: { requires: [SHELL_PROMPTS_SERVICE, SHELL_FILES_SERVICE] } }),
      module: { activate: (context: PluginContext) => {
        seen = { prompts: context.services.get(SHELL_PROMPTS_SERVICE), files: context.services.get(SHELL_FILES_SERVICE) }
      } }
    }])

    await new PluginManager(source, runtime, log).activateAll()

    expect(log.warn).not.toHaveBeenCalled()
    expect(typeof seen.prompts?.confirm).toBe('function')
    expect(seen.files?.documentsPath()).toBe('/docs')
  })

  it("contributes the shell's own prompt dialog", () => {
    const { runtime, dialogs } = setup()
    expect(runtime.extensions.getContributions(DIALOGS_EXTENSION_POINT).map(c => c.id)).toEqual([PROMPT_DIALOG])
    expect(dialogs.list()).toEqual([{ id: PROMPT_DIALOG, title: 'Tessera', module: './Prompt', size: 'xs', pluginId: 'shell' }])
  })

  it('routes a window\'s ready signal to the dialogs, and its answer back to the caller', async () => {
    const { runtime, ask, sent, reveal } = setup()
    const prompts = runtime.services.get<ShellPrompts>(SHELL_PROMPTS_SERVICE)
    const answer = prompts.prompt({ message: 'Name?' })
    expect(sent).toEqual([])

    await ask(WINDOW_READY, undefined, 1)
    expect(reveal.rendererReady).toHaveBeenCalledWith(1)
    expect(sent).toHaveLength(1)

    await expect(ask(DIALOG_CLOSE, { requestId: sent[0].requestId, result: ' Rentals ' }, 1)).resolves.toMatchObject({ ok: true })
    await expect(answer).resolves.toBe('Rentals')
  })

  it('rejects an answer from another window, and keeps waiting for the right one', async () => {
    const { runtime, ask, sent } = setup()
    await ask(WINDOW_READY, undefined, 1)
    runtime.services.get<ShellPrompts>(SHELL_PROMPTS_SERVICE).prompt({ message: 'Name?' })

    await expect(ask(DIALOG_CLOSE, { requestId: sent[0].requestId, result: 'x' }, 2))
      .resolves.toMatchObject({ ok: false, error: { code: 'HANDLER_ERROR', message: expect.stringContaining('another window') } })
  })
})
