// Tools ▸ Options ▸ Import and export. Every setting here changes how a file is read; the write-side choices
// live in the export dialog, where they are per-export.
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EXCHANGE_OPTIONS_DEFAULTS, type ExchangeOptions } from '@tessera/exchange-api'
import OptionsPage from '../../../../plugins/exchange/src/renderer/OptionsPage'

/**
 * The page is controlled: the options dialog owns the draft and hands it back on every change. The harness has
 * to do the same, or a text box would never show what was typed into it.
 */
function setup(over: Partial<ExchangeOptions> = {}, disabled = false) {
  const onChange = vi.fn()
  const onValidityChange = vi.fn()

  function Host() {
    const [value, setValue] = useState<ExchangeOptions>({ ...EXCHANGE_OPTIONS_DEFAULTS, ...over })
    return (
      <OptionsPage
        value={value} defaults={EXCHANGE_OPTIONS_DEFAULTS} disabled={disabled}
        onChange={next => { onChange(next); setValue(next) }}
        onValidityChange={onValidityChange} />
    )
  }
  render(<Host />)
  return { onChange, onValidityChange }
}

/** The last value the page proposed. */
const proposed = (onChange: ReturnType<typeof vi.fn>): ExchangeOptions => onChange.mock.calls.at(-1)![0]

describe('what it shows', () => {
  it('opens on the stored values', () => {
    setup({ import: { ...EXCHANGE_OPTIONS_DEFAULTS.import, dateWindow: 5, adoptBankDetail: true } })
    expect(screen.getByLabelText('Days either side for a match')).toHaveValue('5')
    expect(screen.getByRole('checkbox', { name: /Take the bank's memo/ })).toBeChecked()
  })

  it('offers only settings about reading a file, not writing one', () => {
    setup()
    // The QIF flavour, the CSV delimiter and the BOM are per-export choices and belong to the export dialog.
    expect(screen.queryByText(/flavour/i)).toBeNull()
    expect(screen.queryByText(/delimiter|separator/i)).toBeNull()
    expect(screen.queryByText(/byte-order mark/i)).toBeNull()
  })

  it('does not offer the two things that are deliberately not options', () => {
    setup()
    // Accepting a row *means* marking it electronic, and rows never start accepted.
    expect(screen.queryByText(/electronic/i)).toBeNull()
    expect(screen.queryByText(/start accepted|pre-accept/i)).toBeNull()
  })

  it('disables everything while a commit is in flight', () => {
    setup({}, true)
    expect(screen.getByLabelText('Days either side for a match')).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: /Apply payee rules/ })).toBeDisabled()
  })
})

describe('changing a setting', () => {
  it('proposes the new value without applying it', async () => {
    const { onChange } = setup()
    await userEvent.click(screen.getByRole('checkbox', { name: /Apply payee rules/ }))
    expect(proposed(onChange).import.applyRules).toBe(false)
  })

  it('keeps the rest of the value untouched', async () => {
    const { onChange } = setup()
    await userEvent.click(screen.getByRole('checkbox', { name: /Create categories/ }))
    const next = proposed(onChange)
    expect(next.import.createCategories).toBe(false)
    expect(next.import.dateWindow).toBe(EXCHANGE_OPTIONS_DEFAULTS.import.dateWindow)
    expect(next.history.keep).toBe(EXCHANGE_OPTIONS_DEFAULTS.history.keep)
  })

  it('changes how QIF dates are read', async () => {
    const { onChange } = setup()
    await userEvent.click(screen.getByLabelText('How QIF dates are read'))
    await userEvent.click(screen.getByRole('option', { name: /Day first/ }))
    expect(proposed(onChange).qif.dateOrder).toBe('dmy')
  })

  it('changes how many imports the history keeps', async () => {
    const { onChange } = setup()
    const box = screen.getByLabelText('Imports to keep in the history')
    await userEvent.clear(box)
    await userEvent.type(box, '25')
    expect(proposed(onChange).history.keep).toBe(25)
  })
})

describe('validity', () => {
  it('says so when a number is out of range, which gates Apply', async () => {
    const { onValidityChange } = setup()
    const box = screen.getByLabelText('Days either side for a match')
    await userEvent.clear(box)
    await userEvent.type(box, '99')
    expect(onValidityChange).toHaveBeenLastCalledWith(false)
  })

  it('says so when a number is cleared altogether', async () => {
    const { onValidityChange } = setup()
    await userEvent.clear(screen.getByLabelText('Imports to keep in the history'))
    expect(onValidityChange).toHaveBeenLastCalledWith(false)
  })

  it('says it is valid again once the number is usable', async () => {
    const { onValidityChange } = setup()
    const box = screen.getByLabelText('Days either side for a match')
    await userEvent.clear(box)
    await userEvent.type(box, '7')
    expect(onValidityChange).toHaveBeenLastCalledWith(true)
  })

  it('a setting with no number to get wrong is always valid', async () => {
    const { onValidityChange } = setup()
    await userEvent.click(screen.getByRole('checkbox', { name: /Apply payee rules/ }))
    expect(onValidityChange).toHaveBeenLastCalledWith(true)
  })
})

describe('clearing a number box', () => {
  // The bug this pins: the draft keeps an unusable number so Apply stays disabled, but rendering it as the
  // text "NaN" left a field the user could not delete or type past — stuck the moment they cleared it.
  it('leaves the box empty and typeable, not showing “NaN”', async () => {
    setup()
    const box = screen.getByLabelText('Days either side for a match')
    await userEvent.clear(box)
    expect(box).toHaveValue('')

    await userEvent.type(box, '7')
    expect(box).toHaveValue('7')
  })

  it('does the same for every number on the page', async () => {
    setup()
    for (const label of ['Refuse a file with more rows than', 'Imports to keep in the history']) {
      const box = screen.getByLabelText(label)
      await userEvent.clear(box)
      expect(box).toHaveValue('')
      await userEvent.type(box, '5')
      expect(box).toHaveValue('5')
    }
  })
})

describe('a number that is not whole', () => {
  // Showing the parsed value turned `1.5` into `1` after the point and then `15`: a valid value Apply would save.
  it('shows what was typed and makes the page invalid, rather than becoming a different valid number', async () => {
    const { onChange, onValidityChange } = setup()
    const box = screen.getByLabelText('Days either side for a match')
    await userEvent.clear(box)
    await userEvent.type(box, '1.5')

    expect(box).toHaveValue('1.5')
    expect(onValidityChange).toHaveBeenLastCalledWith(false)
    expect(Number.isNaN(proposed(onChange).import.dateWindow)).toBe(true)
  })

  it('refuses scientific notation too, which Number() would read as a large number', async () => {
    const { onValidityChange } = setup()
    const box = screen.getByLabelText('Refuse a file with more rows than')
    await userEvent.clear(box)
    await userEvent.type(box, '1e3')
    expect(box).toHaveValue('1e3')
    expect(onValidityChange).toHaveBeenLastCalledWith(false)
  })
})
