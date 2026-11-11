// @vitest-environment node
// The Settings Inspector as the app runs it: activated on a runtime whose settings are real JSON files in a
// temporary user-data folder, reached from Tools and answering its dialog over IPC.
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SETTINGS_FOLDER, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { createPluginContext, createPluginRuntime } from '../../../core/plugins/PluginContext'
import { resolveDialogs } from '../../../shared/dialogs/resolveDialogs'
import { resolveMenus } from '../../../shared/menus/resolveMenus'
import { activate } from '../../../plugins/settings-inspector/src/privileged/index'
import { INSPECTOR, type InspectorReport } from '../../../plugins/settings-inspector/src/shared'
import { createJsonSettingsPersistence } from '../../../shell/main/settings/jsonSettingsPersistence'
import { createLogger } from '../../helpers/runtime'
import { createTempModulesDir } from '../../helpers/tempModules'

async function setup() {
  const userData = createTempModulesDir()
  const log = createLogger()
  const runtime = createPluginRuntime(userData, log, {
    settingsPersistence: createJsonSettingsPersistence(path.join(userData, SETTINGS_FOLDER), log)
  })
  await runtime.settings.load()
  const prompts = { show: vi.fn(async () => undefined), confirm: vi.fn(), message: vi.fn(), prompt: vi.fn() }
  runtime.services.provide('shell', SHELL_PROMPTS_SERVICE, prompts)
  activate(createPluginContext('settings-inspector', runtime, { requires: [SHELL_PROMPTS_SERVICE] }).context)
  const ask = async () => {
    const reply = await runtime.ipc.dispatch({ channel: INSPECTOR.report }, { windowId: 1 })
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.data as InspectorReport
  }
  return { userData, runtime, prompts, ask }
}

describe('the settings inspector plugin', () => {
  it('adds Tools ▸ Settings Inspector… beside the developer tools, and a dialog the shell can show', async () => {
    const { runtime } = await setup()
    const contributions = (point: string) => runtime.extensions.getContributions(point)

    const { menus, diagnostics } = resolveMenus([
      { kind: 'menu', id: 'shell.tools', label: '&Tools' },
      { kind: 'group', id: 'shell.developer', parent: 'shell.tools', order: 10_000 },
      { kind: 'item', id: 'shell.tools.devTools', label: 'Toggle &Developer Tools', parent: 'shell.tools', group: 'shell.developer', command: 'shell.toggleDevTools' },
      ...contributions('shell.menus').map(c => c.impl)
    ])
    expect(diagnostics).toEqual([])
    expect(menus[0].children.filter(n => n.type === 'item').map(n => (n as { label: string }).label))
      .toEqual(['Toggle &Developer Tools', 'Settings &Inspector…'])

    const dialogs = resolveDialogs(contributions('shell.dialogs'), () => 'tessera-plugin://settings-inspector/remoteEntry.js')
    expect(dialogs.diagnostics).toEqual([])
    expect(dialogs.dialogs).toMatchObject([{ id: INSPECTOR.dialog, title: 'Settings Inspector', module: './InspectorDialog', size: 'lg' }])
  })

  it('shows its dialog from the command', async () => {
    const { runtime, prompts } = await setup()
    await runtime.commands.execute(INSPECTOR.command)
    expect(prompts.show).toHaveBeenCalledWith(INSPECTOR.dialog)
  })

  it('reports every namespace and the files in <userData>/settings, read-only', async () => {
    const { runtime, userData, ask } = await setup()
    const ledger = createPluginContext('ledger', runtime).context.settings.register({ defaults: { reopenLast: true } })

    expect(await ask()).toMatchObject({
      folder: path.join(userData, SETTINGS_FOLDER), folderExists: false, namespaces: [{ id: 'ledger', owner: 'ledger', check: 'defaults' }]
    })

    await ledger.update({ reopenLast: false })
    await runtime.settings.flush()
    const report = await ask()
    expect(report.namespaces[0]).toMatchObject({ check: 'matches', changed: ['reopenLast'], file: { name: 'ledger.json' } })
    // Asking changed nothing
    expect(ledger.get()).toEqual({ reopenLast: false })
  })
})
