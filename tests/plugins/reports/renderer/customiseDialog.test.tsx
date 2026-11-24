// Customise Report… (phase R4): every option of every shipped definition drawn and applied, as the command gives them;
// Show the top (a number of rows, or every row; left at its default, not kept, so a report taking its top from the
// Reports page keeps following it); Open on; Restore Defaults.
import { cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { CustomiseDialogInput, CustomiseOption, ReportDefinitionContribution } from '@tessera/reports-api'
import CustomiseDialog from '../../../../plugins/reports/src/renderer/CustomiseDialog'
import { DEFINITIONS } from '../../../../plugins/reports/src/privileged/definitions'
import { renderInTheme } from './fixtures'

/** A definition's options as Customise Report… gives them, each at its default. */
const optionsOf = (d: ReportDefinitionContribution): CustomiseOption[] => (d.options ?? []).map(o => ({
  key: o.key, label: o.label, ...(o.description && { description: o.description }), kind: o.kind,
  ...(o.choices && { choices: o.choices.map(c => ({ value: c.value, label: c.label })) }), default: o.default, value: o.default
}))

function open(input: Partial<CustomiseDialogInput> = {}) {
  const close = vi.fn()
  renderInTheme(<CustomiseDialog input={{ title: 'A report', options: [], ...input }} close={close} setBusy={vi.fn()} />)
  return close
}

describe('Customise Report…', () => {
  it.each(DEFINITIONS.map(d => [d.label, d] as const))('draws every option of %s and applies each value', async (_label, definition) => {
    const options = optionsOf(definition)
    for (const option of options) {
      const values = option.kind === 'boolean' ? [true] : option.choices!.map(c => c.value).filter(v => v !== option.default)
      for (const value of values) {
        const close = open({ title: definition.label, options })
        if (option.kind === 'boolean') {
          await userEvent.click(screen.getByRole('checkbox', { name: option.label }))
        } else {
          const group = screen.getByRole('radiogroup', { name: option.label })
          expect(within(group).getAllByRole('radio').map(r => r.closest('label')!.textContent)).toEqual(option.choices!.map(c => c.label))
          await userEvent.click(within(group).getByRole('radio', { name: option.choices!.find(c => c.value === value)!.label }))
        }
        await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
        const defaults = Object.fromEntries(options.map(o => [o.key, o.default]))
        expect(close).toHaveBeenCalledWith({ options: { ...defaults, [option.key]: value } })
        cleanup()
      }
    }
  })

  it('takes Show the top as a number of rows, or every row; at its default it isn’t kept', async () => {
    let close = open({ top: { value: 25, default: 25 } })
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(close).toHaveBeenCalledWith({ options: {} })
    cleanup()

    close = open({ top: { value: 25, default: 25 } })
    const rows = screen.getByRole('textbox', { name: 'Show the top' })
    await userEvent.clear(rows)
    await userEvent.type(rows, '10')
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(close).toHaveBeenCalledWith({ options: { '@top': '10' } })
    cleanup()

    close = open({ top: { value: 10, default: 25 } })
    await userEvent.click(screen.getByRole('checkbox', { name: 'Every row' }))
    expect(screen.getByRole('textbox', { name: 'Show the top' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(close).toHaveBeenCalledWith({ options: { '@top': 'all' } })
  })

  it('says what is wrong with a number of rows, and won’t apply it', async () => {
    const close = open({ top: { value: 6, default: 6 } })
    const rows = screen.getByRole('textbox', { name: 'Show the top' })
    for (const bad of ['0', '501', 'ten', '2.5']) {
      await userEvent.clear(rows)
      await userEvent.type(rows, bad)
      expect(screen.getByText('Show 1 to 500 rows, or tick Every row.')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    }
    await userEvent.keyboard('{Enter}')
    expect(close).not.toHaveBeenCalled()
  })

  it('opens on the chart, the table or both, and restores every default', async () => {
    const payee = DEFINITIONS.find(d => d.id === 'reports.spendingByPayee')!
    const close = open({ options: optionsOf(payee).map(o => ({ ...o, value: 'income' })), top: { value: 10, default: 25 }, show: 'both' })
    await userEvent.click(screen.getByRole('radio', { name: 'The table' }))
    await userEvent.click(screen.getByRole('button', { name: 'Restore Defaults' }))
    expect(screen.getByRole('radio', { name: 'Spending: who you paid' })).toBeChecked()
    expect(screen.getByRole('textbox', { name: 'Show the top' })).toHaveValue('25')
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(close).toHaveBeenCalledWith({ options: { what: 'spending' }, show: 'table' })
  })

  it('says when there is nothing to customise, and closes with nothing when cancelled', async () => {
    const close = open()
    expect(screen.getByText('This report has nothing to customise.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(close).toHaveBeenCalledWith()
  })
})
