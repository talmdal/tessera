// QIF Options: only the questions asked, each with the file's example read every way, the choice offered first
// selected, and its answers: OK with the choices, Skip This File, Cancel Import.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import OptionsDialog from '../../../../plugins/format-qif/src/renderer/OptionsDialog'
import type { OptionsDialogInput } from '../../../../plugins/format-qif/src/shared/options'

const DATES: OptionsDialogInput['dates'] = {
  example: '01/08/2026', value: 'DMY',
  choices: [{ value: 'MDY', label: 'Month/Day/Year: 01/08/2026 is Jan 8, 2026' }, { value: 'DMY', label: 'Day/Month/Year: 01/08/2026 is Aug 1, 2026' }]
}
const DECIMAL: OptionsDialogInput['decimal'] = {
  example: '-1,234', value: '.',
  choices: [{ value: '.', label: 'A point for decimals (1,234.56): “-1,234” is -1234' }, { value: ',', label: 'A comma for decimals (1.234,56): “-1,234” is -1.234' }]
}

async function show(input: OptionsDialogInput) {
  const close = vi.fn()
  render(<OptionsDialog input={input} close={close} setBusy={vi.fn()} />)
  await waitFor(() => expect(document.activeElement).not.toBe(document.body))
  return close
}

describe('the QIF Options dialog', () => {
  it('asks only about the dates, with the file’s example both ways and the likelier chosen, focused', async () => {
    await show({ fileName: 'Savings.qif', dates: DATES })
    expect(screen.getByText('Savings.qif can be read more than one way. Choose how, and files like it will be read the same way.')).toBeInTheDocument()
    const group = screen.getByRole('radiogroup', { name: 'Dates: every day in the file is 12 or less, so “01/08/2026” could be either' })
    expect(group).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Day/Month/Year: 01/08/2026 is Aug 1, 2026' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Day/Month/Year: 01/08/2026 is Aug 1, 2026' })).toHaveFocus()
    expect(screen.queryByRole('radiogroup', { name: /^Amounts/ })).not.toBeInTheDocument()
  })

  it('closes with what was chosen', async () => {
    const close = await show({ fileName: 'x.qif', dates: DATES, decimal: DECIMAL })
    await userEvent.click(screen.getByRole('radio', { name: 'Month/Day/Year: 01/08/2026 is Jan 8, 2026' }))
    await userEvent.click(screen.getByRole('radio', { name: /^A comma for decimals/ }))
    await userEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(close).toHaveBeenCalledWith({ kind: 'options', dateOrder: 'MDY', decimal: ',' })
  })

  it('asks only about amounts, focused there', async () => {
    const close = await show({ fileName: 'x.qif', decimal: DECIMAL })
    expect(screen.getByRole('radio', { name: /^A point for decimals/ })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(close).toHaveBeenCalledWith({ kind: 'options', decimal: '.' })
  })

  it('skips the file, or cancels the import', async () => {
    const close = await show({ fileName: 'x.qif', dates: DATES })
    await userEvent.click(screen.getByRole('button', { name: 'Skip This File' }))
    expect(close).toHaveBeenCalledWith({ kind: 'skip' })
    await userEvent.click(screen.getByRole('button', { name: 'Cancel Import' }))
    expect(close).toHaveBeenLastCalledWith()
  })
})
