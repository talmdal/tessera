// Statement Sources: each linked source with its own matching window, and the chance to forget one.
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SourcesDialogInput } from '@tessera/exchange-api'
import SourcesDialog from '../../../../plugins/exchange/src/renderer/SourcesDialog'

const input = (over: Partial<SourcesDialogInput> = {}): SourcesDialogInput => ({
  sources: [
    { id: 'l1', label: 'RBC chequing', accountName: 'Chequing', formatLabel: 'OFX statement (*.ofx)', numberKey: '1234567890', lastImportedAt: '2026-11-18T09:00:00.000Z' },
    { id: 'l2', label: 'Visa', accountName: 'Visa', formatLabel: 'Quicken Web Connect (*.qfx)', numberKey: '4512', dateWindow: 7 }
  ],
  defaultWindow: 3,
  maxWindow: 60,
  ...over
})

function setup(over: Partial<SourcesDialogInput> = {}) {
  const close = vi.fn()
  render(<SourcesDialog input={input(over)} close={close} setBusy={() => {}} />)
  return { close }
}

const windowBox = (label: string) => screen.getByLabelText(`Days either side for ${label}`)
const save = () => screen.getByRole('button', { name: 'Save' })

describe('what it shows', () => {
  it('lists each source with its account, format and masked number', () => {
    setup()
    const table = screen.getByRole('table', { name: 'Statement sources' })
    expect(within(table).getByText('RBC chequing')).toBeInTheDocument()
    expect(within(table).getByText('Chequing')).toBeInTheDocument()
    expect(within(table).getByText(/OFX statement/)).toBeInTheDocument()
    // The account number is never shown whole.
    expect(within(table).queryByText(/1234567890/)).toBeNull()
  })

  it('shows a source’s own window, and the option as the placeholder for one without', () => {
    setup()
    expect(windowBox('Visa')).toHaveValue('7')
    expect(windowBox('RBC chequing')).toHaveValue('')
    expect(windowBox('RBC chequing')).toHaveAttribute('placeholder', '3')
    expect(screen.getByText(/use the setting in Options \(3 days\)/)).toBeInTheDocument()
  })
})

describe('setting a window', () => {
  it('sends only the sources whose window changed', async () => {
    const { close } = setup()
    await userEvent.type(windowBox('RBC chequing'), '5')
    await userEvent.click(save())
    expect(close).toHaveBeenCalledWith({ windows: [{ id: 'l1', dateWindow: 5 }], removed: [] })
  })

  it('clearing a window sends null, which goes back to the option', async () => {
    const { close } = setup()
    await userEvent.clear(windowBox('Visa'))
    await userEvent.click(save())
    expect(close).toHaveBeenCalledWith({ windows: [{ id: 'l2', dateWindow: null }], removed: [] })
  })

  it('sends nothing when nothing changed', async () => {
    const { close } = setup()
    await userEvent.click(save())
    expect(close).toHaveBeenCalledWith({ windows: [], removed: [] })
  })

  it('accepts 0, which means the same day only', async () => {
    const { close } = setup()
    await userEvent.type(windowBox('RBC chequing'), '0')
    await userEvent.click(save())
    expect(close).toHaveBeenCalledWith({ windows: [{ id: 'l1', dateWindow: 0 }], removed: [] })
  })

  it('refuses a window outside the range, and says what the range is', async () => {
    setup()
    await userEvent.type(windowBox('RBC chequing'), '61')
    expect(save()).toBeDisabled()
    expect(screen.getByText(/whole number of days from 0 to 60/)).toBeInTheDocument()
  })

  it('refuses something that is not a whole number', async () => {
    setup()
    for (const text of ['2.5', '-1', 'x']) {
      await userEvent.clear(windowBox('RBC chequing'))
      await userEvent.type(windowBox('RBC chequing'), text)
      expect(save()).toBeDisabled()
    }
  })

  it('stays editable after being cleared, rather than sticking on an unusable value', async () => {
    setup()
    await userEvent.clear(windowBox('Visa'))
    expect(windowBox('Visa')).toHaveValue('')
    await userEvent.type(windowBox('Visa'), '10')
    expect(windowBox('Visa')).toHaveValue('10')
  })
})

describe('forgetting a source', () => {
  it('sends it as removed, and does not also send its window', async () => {
    const { close } = setup()
    await userEvent.type(windowBox('RBC chequing'), '5')
    await userEvent.click(screen.getByLabelText('Forget RBC chequing'))
    await userEvent.click(save())
    expect(close).toHaveBeenCalledWith({ windows: [], removed: ['l1'] })
  })

  it('does not let an unusable window on a forgotten source block the save', async () => {
    setup()
    await userEvent.type(windowBox('RBC chequing'), '99')
    expect(save()).toBeDisabled()
    await userEvent.click(screen.getByLabelText('Forget RBC chequing'))
    expect(save()).toBeEnabled()
  })

  it('can be changed back before saving', async () => {
    const { close } = setup()
    await userEvent.click(screen.getByLabelText('Forget Visa'))
    await userEvent.click(screen.getByLabelText('Forget Visa'))
    await userEvent.click(save())
    expect(close).toHaveBeenCalledWith({ windows: [], removed: [] })
  })
})

describe('cancelling', () => {
  it('closes with nothing', async () => {
    const { close } = setup()
    await userEvent.type(windowBox('RBC chequing'), '5')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(close).toHaveBeenCalledWith()
  })
})
