import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import InspectorDialog from '../../../../plugins/settings-inspector/src/renderer/InspectorDialog'
import { INSPECTOR, type InspectorReport } from '../../../../plugins/settings-inspector/src/shared'
import { createFakeRemote } from '../../../helpers/fakeBridge'

const FOLDER = 'C:\\Users\\tim\\AppData\\Roaming\\tessera\\settings'

const report = (over: Partial<InspectorReport> = {}): InspectorReport => ({
  folder: FOLDER, folderExists: true, at: '2026-11-08T10:00:00.000Z',
  namespaces: [
    {
      id: 'import', owner: 'import', value: { matching: 'balanced' }, defaults: { matching: 'balanced' }, check: 'defaults',
      note: 'Every setting is at its default, so nothing is saved: only differences are written.', changed: []
    },
    {
      id: 'ledger', owner: 'ledger', value: { reopenLast: false, recentLimit: 10 }, defaults: { reopenLast: true, recentLimit: 10 },
      check: 'matches', note: 'What is in effect is exactly the saved values merged over the defaults.', changed: ['reopenLast'],
      file: { name: 'ledger.json', path: `${FOLDER}\\ledger.json`, text: '{\n  "version": 1,\n  "values": {\n    "reopenLast": false\n  }\n}\n', modified: '2026-11-08T09:59:00.000Z', version: 1, values: { reopenLast: false } }
    }
  ],
  others: [{ name: 'ledger.json.bad', path: `${FOLDER}\\ledger.json.bad`, text: 'not json', modified: '2026-11-07T08:00:00.000Z', problem: 'It is not valid JSON' }],
  ...over
})

function setup(answer: () => InspectorReport | Promise<InspectorReport> = () => report()) {
  const remote = createFakeRemote({})
  remote.bridge.invoke.mockImplementation(async (channel: string) => {
    if (channel !== INSPECTOR.report) throw new Error(`No answer for ${channel}`)
    return answer()
  })
  ;(window as any).api = remote.bridge
  const close = vi.fn()
  render(<InspectorDialog input={undefined} close={close} setBusy={vi.fn()} />)
  const asked = () => remote.bridge.invoke.mock.calls.filter((c: unknown[]) => c[0] === INSPECTOR.report).length
  return { ...remote, close, asked }
}

const nav = () => screen.getByRole('navigation', { name: 'Settings namespaces' })

describe('the settings inspector dialog', () => {
  it('lists each namespace with whether it agrees with its file, and the files no namespace reads', async () => {
    setup()
    await screen.findByText(/Settings folder:/)

    // Each row is announced with its status first
    const rows = within(nav()).getAllByRole('button')
    expect(rows[0]).toHaveAccessibleName('At its defaults import defaults')
    expect(rows[1]).toHaveAccessibleName('Matches its file ledger 1 changed')
    expect(rows[2]).toHaveAccessibleName('Not read by any namespace ledger.json.bad')
    expect(screen.getByText(FOLDER)).toBeInTheDocument()
  })

  it('shows what plugins read, the file exactly as on disk, and the defaults, side by side', async () => {
    setup()
    await userEvent.click(await within(await screen.findByRole('navigation', { name: 'Settings namespaces' })).findByRole('button', { name: /ledger 1 changed$/ }))

    expect(screen.getByText(/Matches its file\. What is in effect is exactly/)).toBeInTheDocument()
    expect(screen.getByText('Registered by ledger. Differs from the defaults: reopenLast.')).toBeInTheDocument()
    expect(screen.getByLabelText('In effect (what plugins read)')).toHaveTextContent('"reopenLast": false')
    expect(screen.getByLabelText(/^Saved file \(written/)).toHaveTextContent('"version": 1')
    expect(screen.getByLabelText('Defaults')).toHaveTextContent('"reopenLast": true')
  })

  it('says there is no file for a namespace at its defaults', async () => {
    setup()
    await screen.findByText(/Settings folder:/)
    expect(screen.getByLabelText('Saved file')).toHaveTextContent('no file: only settings that differ from their defaults are saved')
  })

  it('explains a set-aside file', async () => {
    setup()
    await userEvent.click(await within(await screen.findByRole('navigation', { name: 'Settings namespaces' })).findByRole('button', { name: /ledger\.json\.bad/ }))
    expect(screen.getByText(/Set aside because it could not be read/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^File \(written/)).toHaveTextContent('not json')
  })

  it('warns about a namespace that differs from its file', async () => {
    const differs = report()
    differs.namespaces[1] = { ...differs.namespaces[1], check: 'differs', note: 'The file may have been changed since Tessera read it.' }
    setup(() => differs)
    await userEvent.click(await within(await screen.findByRole('navigation', { name: 'Settings namespaces' })).findByRole('button', { name: /ledger 1 changed$/ }))
    expect(screen.getByRole('img', { name: 'Differs from its file' })).toBeInTheDocument()
    expect(screen.getByText(/Differs from its file\. The file may have been changed/)).toBeInTheDocument()
  })

  it('says when nothing has been saved yet', async () => {
    setup(() => report({ folderExists: false, others: [] }))
    expect(await screen.findByText(/not created yet: nothing has been saved/)).toBeInTheDocument()
  })

  it('reads again on Refresh, and a moment after any settings change', async () => {
    const { asked, emit } = setup()
    await screen.findByText(/Settings folder:/)
    expect(asked()).toBe(1)

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(asked()).toBe(2))

    await act(async () => { emit('shell:settings.changed', { id: 'ledger' }) })
    await waitFor(() => expect(asked()).toBe(3), { timeout: 2000 })
  })

  it('says so when the settings cannot be read, and closes', async () => {
    const { close } = setup(() => Promise.reject(new Error('gone')))
    expect(await screen.findByText('The settings could not be read: gone')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(close).toHaveBeenCalled()
  })
})
