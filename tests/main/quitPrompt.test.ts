import { describe, expect, it, vi } from 'vitest'
import { askToQuit } from '../../shell/main/lifecycle/quitPrompt'

function platform(response: number, focused: unknown = { id: 1 }) {
  return {
    dialog: { showMessageBox: vi.fn(async (..._args: any[]) => ({ response })) },
    BrowserWindow: { getFocusedWindow: vi.fn(() => focused), fromId: vi.fn() }
  }
}

describe('"Tessera can\'t close yet"', () => {
  it('lists every reason, offers Retry, Quit Anyway and Cancel, with Cancel the default, modal to the focused window', async () => {
    const p = platform(2)
    expect(await askToQuit(p, ['“Importing statements” is still running.', '“Home” couldn’t be backed up.'])).toBe('cancel')
    expect(p.dialog.showMessageBox).toHaveBeenCalledWith({ id: 1 }, {
      type: 'warning', title: 'Tessera', message: 'Tessera can’t close yet.',
      detail: '“Importing statements” is still running.\n\n“Home” couldn’t be backed up.',
      buttons: ['Retry', 'Quit Anyway', 'Cancel'], defaultId: 2, cancelId: 2, noLink: true
    })
  })

  it('answers what was chosen, unparented when no window has the focus', async () => {
    expect(await askToQuit(platform(0), ['x'])).toBe('retry')
    const unparented = platform(1, null)
    expect(await askToQuit(unparented, ['x'])).toBe('quit')
    expect(unparented.dialog.showMessageBox.mock.calls[0]).toHaveLength(1)
  })
})
