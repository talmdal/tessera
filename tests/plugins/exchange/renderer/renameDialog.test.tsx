// Rename Payee. Most of these are about the preview, because the preview is why this is a dialog rather than
// an inline edit: renaming happens before matching, so a new name can turn a row from new into a merge, and
// the user has to see that before agreeing to it.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXCHANGE_CHANNELS, type RenameDialogInput, type RenamePreview } from '@tessera/exchange-api'
import RenameDialog from '../../../../plugins/exchange/src/renderer/RenameDialog'

const NOISY = 'SQ *THE DAILY GRIND 4471 OTTAWA ON'

const asNew: RenamePreview = { payee: NOISY, disposition: 'new', note: 'New' }
const asMerge: RenamePreview = {
  payee: 'The Daily Grind', disposition: 'merge', note: 'Matches 3 Nov', matchedId: 't1',
  matches: { date: '2026-11-03', amount: -450, payee: 'The Daily Grind' }
}

const input = (over: Partial<RenameDialogInput> = {}): RenameDialogInput => ({
  accountId: 'a1', statementId: 's1', rowKey: 'r0',
  original: NOISY, payee: NOISY, renamed: false, preview: asNew, offerLearning: true,
  categories: [{ id: 'c1', label: 'Food : Dining out' }],
  currency: 'CAD', amount: -450, date: '2026-11-03',
  ...over
})

/** The preview channel, answering with whatever the test queues. */
let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  invoke = vi.fn(async () => ({ ok: true, value: asMerge }))
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = { invoke, on: vi.fn(() => () => {}) }
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => vi.useRealTimers())

function setup(over: Partial<RenameDialogInput> = {}) {
  const close = vi.fn()
  render(<RenameDialog input={input(over)} close={close} setBusy={() => {}} />)
  return { close }
}

const payeeBox = () => screen.getByLabelText('Payee')

describe('what it opens showing', () => {
  it('shows the bank’s own text as well as the name in the box', () => {
    setup()
    expect(screen.getByText(NOISY)).toBeInTheDocument()
    expect(payeeBox()).toHaveValue(NOISY)
  })

  it('opens on the row’s current disposition, without asking for a preview', () => {
    setup()
    expect(screen.getByText('New')).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('shows the tidy name when a rule already renamed the row', () => {
    setup({ payee: 'The Daily Grind', preview: asMerge })
    expect(payeeBox()).toHaveValue('The Daily Grind')
    expect(screen.getByText('Matches 3 Nov')).toBeInTheDocument()
  })
})

describe('the live preview', () => {
  it('asks what the row would become once the typing settles', async () => {
    setup()
    await userEvent.clear(payeeBox())
    await userEvent.type(payeeBox(), 'The Daily Grind')

    await waitFor(() => expect(invoke).toHaveBeenCalled())
    expect(invoke).toHaveBeenCalledWith(EXCHANGE_CHANNELS.renamePreview, {
      accountId: 'a1', statementId: 's1', rowKey: 'r0', payee: 'The Daily Grind'
    })
    await waitFor(() => expect(screen.getByText('Matches 3 Nov')).toBeInTheDocument())
  })

  it('shows the transaction the row would merge with, so the match is checkable', async () => {
    setup()
    await userEvent.clear(payeeBox())
    await userEvent.type(payeeBox(), 'The Daily Grind')
    await waitFor(() => expect(screen.getByText(/The Daily Grind$/)).toBeInTheDocument())
  })

  it('asks with null when the box is cleared, meaning “let the rules decide”', async () => {
    setup({ payee: 'Coffee Shop', renamed: true })
    await userEvent.clear(payeeBox())

    await waitFor(() => expect(invoke).toHaveBeenCalled())
    expect(invoke).toHaveBeenCalledWith(EXCHANGE_CHANNELS.renamePreview,
      expect.objectContaining({ payee: null }))
    expect(screen.getByText(/payee rules decide/i)).toBeInTheDocument()
  })

  it('does not ask again when the name is typed back to what it was', async () => {
    setup({ payee: 'Coffee' })
    await userEvent.type(payeeBox(), 'X')
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))

    invoke.mockClear()
    await userEvent.type(payeeBox(), '{backspace}')
    // Back to the original, so the preview it opened with stands and nothing is asked.
    await waitFor(() => expect(screen.getByText('New')).toBeInTheDocument())
    expect(invoke).not.toHaveBeenCalled()
  })

  it('ignores a slow answer to a keystroke the user has already typed past', async () => {
    const slow = { ok: true, value: { payee: 'Stale', disposition: 'new' as const, note: 'STALE' } }
    const fresh = { ok: true, value: asMerge }
    let resolveSlow: (v: unknown) => void = () => {}
    invoke
      .mockImplementationOnce(() => new Promise(resolve => { resolveSlow = resolve }))
      .mockImplementationOnce(async () => fresh)

    setup()
    await userEvent.clear(payeeBox())
    await userEvent.type(payeeBox(), 'A')
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    await userEvent.type(payeeBox(), 'B')
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))

    // The first request finally answers, after the second already has.
    resolveSlow(slow)
    await waitFor(() => expect(screen.getByText('Matches 3 Nov')).toBeInTheDocument())
    expect(screen.queryByText('STALE')).not.toBeInTheDocument()
  })

  it('keeps the last good preview when the channel fails, rather than showing nothing', async () => {
    invoke.mockRejectedValue(new Error('no'))
    setup()
    await userEvent.type(payeeBox(), 'X')
    await waitFor(() => expect(invoke).toHaveBeenCalled())
    expect(screen.getByText('New')).toBeInTheDocument()
  })
})

describe('what it closes with', () => {
  it('returns the typed name', async () => {
    const { close } = setup()
    await userEvent.clear(payeeBox())
    await userEvent.type(payeeBox(), 'The Daily Grind')
    await userEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(close).toHaveBeenCalledWith({ payee: 'The Daily Grind', always: false })
  })

  it('returns null when the box was cleared, which clears the rename', async () => {
    const { close } = setup({ payee: 'Coffee Shop', renamed: true })
    await userEvent.clear(payeeBox())
    await userEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(close).toHaveBeenCalledWith({ payee: null, always: false })
  })

  it('asks for a rule when “always rename this” is ticked', async () => {
    const { close } = setup()
    await userEvent.clear(payeeBox())
    await userEvent.type(payeeBox(), 'The Daily Grind')
    await userEvent.click(screen.getByRole('checkbox', { name: /Always rename this/ }))
    await userEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(close).toHaveBeenCalledWith({ payee: 'The Daily Grind', always: true })
  })

  it('cannot ask for a rule with no name to write, since there would be nothing to learn', async () => {
    setup({ payee: 'Coffee Shop', renamed: true })
    await userEvent.clear(payeeBox())
    expect(screen.getByRole('checkbox', { name: /Always rename this/ })).toBeDisabled()
  })

  it('closes with nothing on Cancel', async () => {
    const { close } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(close).toHaveBeenCalledWith()
  })
})

describe('found in review', () => {
  it('sends nothing back for a field left alone, so a rule’s name is not pinned as the user’s', async () => {
    const { close } = setup({ payee: 'The Daily Grind', preview: asMerge })
    await userEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(close).toHaveBeenCalledWith({ always: false })
  })

  it('sends a category only once the user changes it', async () => {
    const { close } = setup()
    await userEvent.click(screen.getByLabelText('Category'))
    await userEvent.click(screen.getByRole('option', { name: 'Food : Dining out' }))
    await userEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(close).toHaveBeenCalledWith({ categoryId: 'c1', always: false })
  })

  it('does not offer to remember a rename when the option is off', () => {
    setup({ offerLearning: false })
    expect(screen.queryByRole('checkbox', { name: /Always rename this/ })).toBeNull()
  })

  it('ignores a reply still in flight after the name is typed back to what it was', async () => {
    let answer: (value: unknown) => void = () => {}
    invoke.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    setup()

    await userEvent.type(payeeBox(), 'X')
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    // Back to the original before the reply arrives.
    await userEvent.type(payeeBox(), '{backspace}')
    answer({ ok: true, value: asMerge })

    await waitFor(() => expect(screen.getByText('New')).toBeInTheDocument())
    expect(screen.queryByText('Matches 3 Nov')).toBeNull()
  })
})

describe('the category', () => {
  it('offers no “None”: a row is without one only because it arrived that way', async () => {
    setup()
    expect(screen.getByLabelText('Category')).toHaveTextContent(/None yet — choose a category/)
    await userEvent.click(screen.getByLabelText('Category'))
    const options = screen.getAllByRole('option').map(o => o.textContent)
    expect(options).toEqual(['Food : Dining out'])
  })

  it('sends nothing for a category left unset', async () => {
    const { close } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(close.mock.calls[0][0]).not.toHaveProperty('categoryId')
  })

  it('shows a category already chosen, and can only change it to another', async () => {
    const { close } = setup({
      categoryId: 'c1',
      categories: [{ id: 'c1', label: 'Food : Dining out' }, { id: 'c2', label: 'Food : Groceries' }]
    })
    expect(screen.getByLabelText('Category')).toHaveTextContent('Food : Dining out')
    await userEvent.click(screen.getByLabelText('Category'))
    expect(screen.queryByRole('option', { name: /None/ })).toBeNull()
    await userEvent.click(screen.getByRole('option', { name: 'Food : Groceries' }))
    await userEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(close.mock.calls[0][0]).toMatchObject({ categoryId: 'c2' })
  })
})
