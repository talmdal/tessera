// The Settings Inspector draws paths and file contents in the Fixed-width text font role.
import { screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import InspectorDialog from '../../../../plugins/settings-inspector/src/renderer/InspectorDialog'
import { INSPECTOR, type InspectorReport } from '../../../../plugins/settings-inspector/src/shared'
import { createFakeRemote } from '../../../helpers/fakeBridge'
import { fontSettings, renderInShell } from '../../../helpers/fonts'

const FOLDER = 'C:\\Users\\tim\\AppData\\Roaming\\tessera\\settings'
const report: InspectorReport = {
  folder: FOLDER, folderExists: true, at: '2026-11-08T10:00:00.000Z', others: [],
  namespaces: [{
    id: 'import', owner: 'import', value: { matching: 'balanced' }, defaults: { matching: 'balanced' }, check: 'defaults',
    note: 'Every setting is at its default.', changed: []
  }]
}

it('draws the folder and the settings in the Fixed-width text font', async () => {
  const remote = createFakeRemote({})
  remote.bridge.invoke.mockImplementation(async (channel: string) => {
    if (channel !== INSPECTOR.report) throw new Error(`No answer for ${channel}`)
    return report
  })
  ;(window as any).api = remote.bridge
  renderInShell(<InspectorDialog input={undefined} close={vi.fn()} setBusy={vi.fn()} />, fontSettings({ monospace: { family: ['Iosevka'], size: 12 } }))

  const folder = await screen.findByText(FOLDER)
  expect(getComputedStyle(folder).fontFamily.startsWith('"Iosevka"')).toBe(true)
  const defaults = screen.getByLabelText('Defaults')
  expect(defaults.tagName).toBe('PRE')
  expect(getComputedStyle(defaults).fontFamily.startsWith('"Iosevka"')).toBe(true)
  expect(getComputedStyle(defaults).fontSize).toBe('0.75rem')
})
