import { describe, expect, it, vi } from 'vitest'
import { createElectronPrompts, PromptsPlatform } from '../../shell/main/dialogs/electronPrompts'
import { PROMPT_DIALOG } from '../../shared/dialogs/types'

function setup(response = 0, focused: unknown = { id: 1 }) {
  const platform = {
    dialog: { showMessageBox: vi.fn(async (..._args: any[]) => ({ response })) },
    BrowserWindow: { getFocusedWindow: vi.fn(() => focused), fromId: vi.fn((id: number) => ({ id })) }
  } satisfies PromptsPlatform
  const dialogs = { show: vi.fn(async (..._args: any[]): Promise<unknown> => 'answer') }
  const prompts = createElectronPrompts(platform, dialogs)
  const boxOptions = () => platform.dialog.showMessageBox.mock.calls[0].at(-1)
  return { platform, dialogs, prompts, boxOptions }
}

describe('shell.prompts: confirm', () => {
  it('asks a question modal to the focused window, with OK first, and resolves true only for OK', async () => {
    const { prompts, platform, boxOptions } = setup(0)
    await expect(prompts.confirm({ message: 'Close “Home”?', detail: 'It is saved.' })).resolves.toBe(true)
    expect(platform.dialog.showMessageBox).toHaveBeenCalledWith({ id: 1 }, expect.any(Object))
    expect(boxOptions()).toEqual({
      type: 'question', buttons: ['OK', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true, message: 'Close “Home”?', detail: 'It is saved.'
    })
    await expect(setup(1).prompts.confirm({ message: 'x' })).resolves.toBe(false)
  })

  it('makes Cancel the default for a destructive action, so Enter does not carry it out', async () => {
    const { prompts, boxOptions } = setup(1)
    await expect(prompts.confirm({ message: 'Move “Home” to the Recycle Bin?', confirmLabel: 'Delete', destructive: true, title: 'Delete' })).resolves.toBe(false)
    expect(boxOptions()).toMatchObject({ type: 'warning', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Delete' })
  })

  it('uses the window asked for, and shows an unparented box when there is no window', async () => {
    const asked = setup()
    await asked.prompts.confirm({ message: 'x', windowId: 4 })
    expect(asked.platform.BrowserWindow.fromId).toHaveBeenCalledWith(4)
    expect(asked.platform.dialog.showMessageBox).toHaveBeenCalledWith({ id: 4 }, expect.any(Object))

    const none = setup(0, null)
    await none.prompts.confirm({ message: 'x' })
    expect(none.platform.dialog.showMessageBox.mock.calls[0]).toHaveLength(1)
  })
})

describe('shell.prompts: message', () => {
  it('shows one button, as info by default', async () => {
    const { prompts, boxOptions } = setup()
    await prompts.message({ message: 'Saved.' })
    expect(boxOptions()).toEqual({ type: 'info', buttons: ['OK'], defaultId: 0, cancelId: 0, noLink: true, message: 'Saved.' })
  })

  it('shows errors and warnings with their own button label', async () => {
    const { prompts, boxOptions } = setup()
    await prompts.message({ message: 'Could not open', detail: 'Not a book.', kind: 'error', buttonLabel: 'Close' })
    expect(boxOptions()).toMatchObject({ type: 'error', buttons: ['Close'], detail: 'Not a book.' })
  })
})

describe('shell.prompts: prompt and show', () => {
  it("shows the shell's prompt dialog with defaults filled in, and trims the answer", async () => {
    const { prompts, dialogs } = setup()
    dialogs.show.mockResolvedValueOnce('  Business  ')

    await expect(prompts.prompt({ message: 'Name of the sub-book', label: 'Name', maxLength: 40 })).resolves.toBe('Business')
    expect(dialogs.show).toHaveBeenCalledWith(PROMPT_DIALOG,
      { message: 'Name of the sub-book', confirmLabel: 'OK', required: true, label: 'Name', maxLength: 40 },
      { title: 'Tessera' })
  })

  it('resolves undefined when the prompt is cancelled, and passes the window and title on', async () => {
    const { prompts, dialogs } = setup()
    dialogs.show.mockResolvedValueOnce(undefined)
    await expect(prompts.prompt({ message: 'm', title: 'Rename', windowId: 3, required: false, defaultValue: 'a' })).resolves.toBeUndefined()
    expect(dialogs.show).toHaveBeenCalledWith(PROMPT_DIALOG, expect.objectContaining({ required: false, defaultValue: 'a' }), { title: 'Rename', windowId: 3 })
  })

  it('shows contributed dialogs through the dialog service', async () => {
    const { prompts, dialogs } = setup()
    dialogs.show.mockResolvedValueOnce({ kind: 'subBook', id: 's1' })
    await expect(prompts.show('book.dialog.new', { parentId: null }, { title: 'New Sub-Book' })).resolves.toEqual({ kind: 'subBook', id: 's1' })
    expect(dialogs.show).toHaveBeenCalledWith('book.dialog.new', { parentId: null }, { title: 'New Sub-Book' })
  })
})
