import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import type { DialogProps, ThemeSnapshot } from '@tessera/types'
import { DIALOG_CLOSE, DIALOG_OPEN, DialogOpen, PROMPT_DIALOG, PROMPT_DIALOG_MODULE } from '../../shared/dialogs/types'
import { DEFAULT_THEME, THEME_GET } from '../../shared/theme/types'
import { DialogHost } from '../../shell/renderer/dialogs/DialogHost'
import { ShellThemeProvider } from '../../shell/renderer/theme/ShellThemeProvider'
import { createFederationViewLoader } from '../../shell/renderer/views/federationViewLoader'
import type { ViewLoader } from '../../shell/renderer/views/ports'
import { createFakeRemote } from '../helpers/fakeBridge'

const theme: ThemeSnapshot = {
  state: { windowId: 1, global: { theme: DEFAULT_THEME.id, mode: 'light' }, theme: DEFAULT_THEME.id, mode: 'light' },
  themes: [DEFAULT_THEME]
}

/** A plugin dialog the fake loader hands out. */
function Rename({ input, close, setBusy }: DialogProps<{ name: string }, { name: string }>) {
  return (
    <>
      <p>Renaming {input.name}</p>
      <button onClick={() => close({ name: `${input.name}!` })}>Save</button>
      <button onClick={() => { close({ name: 'first' }); close({ name: 'second' }) }}>Save twice</button>
      <button onClick={() => setBusy(true)}>Start saving</button>
      <button onClick={() => close()}>Cancel</button>
    </>
  )
}
function Broken(): never { throw new Error('broken dialog') }

function setup(loader: ViewLoader = { load: vi.fn(async (m: { module: string }) => (m.module === './Broken' ? Broken : Rename) as ComponentType<any>) }) {
  const remote = createFakeRemote({ [THEME_GET]: () => theme, [DIALOG_CLOSE]: () => undefined })
  render(
    <ShellThemeProvider bridge={remote.bridge} initial={theme}>
      <DialogHost bridge={remote.bridge} loader={loader} />
    </ShellThemeProvider>)

  let sequence = 0
  const open = async (over: Partial<DialogOpen> = {}, dialog: Partial<DialogOpen['dialog']> = {}) => {
    const message: DialogOpen = {
      windowId: 1, requestId: `r${++sequence}`, title: 'Rename Sub-Book', input: { name: 'Business' },
      dialog: { id: 'book.dialog.rename', title: 'Rename', module: './Rename', size: 'xs', pluginId: 'book', remoteEntry: 'tessera-plugin://book/remoteEntry.js', ...dialog },
      ...over
    }
    await act(async () => { remote.emit(DIALOG_OPEN, message) })
    return message
  }
  const closes = () => remote.bridge.invoke.mock.calls.filter((c: unknown[]) => c[0] === DIALOG_CLOSE).map((c: any[]) => c[1])
  return { ...remote, loader, open, closes }
}

const dialog = (name = 'Rename Sub-Book') => screen.findByRole('dialog', { name })

describe('the dialog host', () => {
  it("shows a plugin's dialog in the shell's frame, titled and with its input, and sends back its result", async () => {
    const { open, closes, loader } = setup()
    const request = await open()

    const shown = await dialog()
    expect(within(shown).getByText('Renaming Business')).toBeInTheDocument()
    expect(loader.load).toHaveBeenCalledWith({ id: 'book.dialog.rename', pluginId: 'book', module: './Rename', remoteEntry: 'tessera-plugin://book/remoteEntry.js' })

    await userEvent.click(within(shown).getByRole('button', { name: 'Save' }))

    expect(closes()).toEqual([{ requestId: request.requestId, result: { name: 'Business!' } }])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('shows only the dialogs sent to its own window', async () => {
    const { open } = setup()
    await open({ windowId: 2 })
    await act(async () => {})
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reports a cancel, from the component or from Escape, without a result', async () => {
    const { open, closes } = setup()
    const first = await open()
    await userEvent.click(within(await dialog()).getByRole('button', { name: 'Cancel' }))
    const second = await open()
    await dialog()
    await userEvent.keyboard('{Escape}')

    expect(closes()).toEqual([{ requestId: first.requestId }, { requestId: second.requestId }])
  })

  it('keeps a busy dialog open on Escape', async () => {
    const { open, closes } = setup()
    await open()
    await userEvent.click(within(await dialog()).getByRole('button', { name: 'Start saving' }))
    await userEvent.keyboard('{Escape}')

    expect(closes()).toEqual([])
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('sends one answer even if the component closes twice', async () => {
    const { open, closes } = setup()
    const request = await open()
    await userEvent.click(within(await dialog()).getByRole('button', { name: 'Save twice' }))
    expect(closes()).toEqual([{ requestId: request.requestId, result: { name: 'first' } }])
  })

  it('shows dialogs one at a time, in order, and ignores a repeat of one it already has', async () => {
    const { open, closes } = setup()
    const first = await open({ title: 'First' })
    const second = await open({ title: 'Second' })
    await open({ ...first })                      // sent again after a reload: not shown twice

    await userEvent.click(within(await dialog('First')).getByRole('button', { name: 'Cancel' }))
    await userEvent.click(within(await dialog('Second')).getByRole('button', { name: 'Cancel' }))

    expect(closes().map((c: { requestId: string }) => c.requestId)).toEqual([first.requestId, second.requestId])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('says so when a dialog fails, and reports the failure when the user closes it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { open, closes } = setup()
    const request = await open({}, { module: './Broken' })

    const shown = await dialog()
    expect(await within(shown).findByText('This dialog could not be displayed.')).toBeInTheDocument()
    await userEvent.click(within(shown).getByRole('button', { name: 'Close' }))

    expect(closes()).toEqual([{ requestId: request.requestId, error: 'broken dialog' }])
  })

  it('reports a module that fails to load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { open, closes } = setup({ load: vi.fn(async () => { throw new Error('remote entry not found') }) })
    const request = await open()
    await within(await dialog()).findByText('This dialog could not be displayed.')
    await userEvent.keyboard('{Escape}')
    expect(closes()).toEqual([{ requestId: request.requestId, error: 'remote entry not found' }])
  })
})

describe("the shell's prompt dialog", () => {
  const openPrompt = async (host: ReturnType<typeof setup>, input: object) => host.open(
    { title: 'New Sub-Book', input: { message: 'Name of the sub-book', confirmLabel: 'Create', required: true, ...input } },
    { id: PROMPT_DIALOG, module: PROMPT_DIALOG_MODULE, pluginId: 'shell', remoteEntry: undefined })

  it('is built in, asks for a required answer, and returns it trimmed', async () => {
    const host = setup()
    const request = await openPrompt(host, { label: 'Name' })
    const shown = await dialog('New Sub-Book')
    expect(host.loader.load).not.toHaveBeenCalled()

    const create = within(shown).getByRole('button', { name: 'Create' })
    expect(create).toBeDisabled()
    await userEvent.type(within(shown).getByRole('textbox', { name: 'Name' }), '  Rentals {Enter}')

    expect(host.closes()).toEqual([{ requestId: request.requestId, result: 'Rentals' }])
  })

  it('starts from the default value, names the field after the message when it has no label, and limits the length', async () => {
    const host = setup()
    await openPrompt(host, { defaultValue: 'Business', maxLength: 10 })
    const field = within(await dialog('New Sub-Book')).getByRole('textbox', { name: 'Name of the sub-book' })
    expect(field).toHaveValue('Business')
    expect(field).toHaveAttribute('maxlength', '10')
  })
})

describe('a dialog from a real plugin remote', () => {
  // Built once by tests/setup/buildUiFixture.ts
  const remoteEntry = inject('themedRemoteEntry')
  beforeEach(() => { URL.createObjectURL = vi.fn(() => 'blob:x'); URL.revokeObjectURL = vi.fn() })
  afterEach(() => { vi.unstubAllGlobals() })

  it("loads through module federation, shares the shell's @tessera/ui, and returns what the user entered", async () => {
    const host = setup(createFederationViewLoader())
    const request = await host.open({ title: 'Name it', input: { name: 'Home' } },
      { id: 'themed.name', module: './NameDialog', pluginId: 'themed', remoteEntry })

    const shown = await dialog('Name it')
    const field = await within(shown).findByRole('textbox', { name: 'Name' }, { timeout: 5_000 })
    await userEvent.clear(field)
    await userEvent.type(field, 'Cottage')
    await userEvent.click(within(shown).getByRole('button', { name: 'Save' }))

    expect(host.closes()).toEqual([{ requestId: request.requestId, result: { name: 'Cottage' } }])
  })
})
