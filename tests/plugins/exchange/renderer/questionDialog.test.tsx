// The question dialog: a reader's choice (the QIF date order), the import's destination question, and a
// currency a file does not name.
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { QuestionDialogInput } from '@tessera/exchange-api'
import QuestionDialog from '../../../../plugins/exchange/src/renderer/QuestionDialog'

function setup(input: QuestionDialogInput) {
  const close = vi.fn()
  render(<QuestionDialog input={input} close={close} setBusy={() => {}} />)
  return { close }
}

describe('a choice', () => {
  const question: QuestionDialogInput = {
    question: {
      kind: 'choice', id: 'exchange-qif.dateOrder', title: 'How are the dates in this file written?',
      detail: 'Every date could be read either way.',
      options: [
        { value: 'mdy', label: 'Month first (M/D/Y)', detail: '5/3\'26 → May 3, 2026' },
        { value: 'dmy', label: 'Day first (D/M/Y)', detail: '5/3\'26 → March 5, 2026' }
      ],
      suggested: 'mdy'
    }
  }

  it('shows the title, the detail and each option with its example, the suggested one selected', () => {
    setup(question)
    expect(screen.getByText('How are the dates in this file written?')).toBeInTheDocument()
    expect(screen.getByText(/Every date could be read/)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Month first/ })).toBeChecked()
    expect(screen.getByText(/March 5, 2026/)).toBeInTheDocument()
  })

  it('closes with the chosen option’s value, or with nothing on Cancel', async () => {
    const { close } = setup(question)
    await userEvent.click(screen.getByRole('radio', { name: /Day first/ }))
    await userEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(close).toHaveBeenCalledWith('dmy')
    const other = setup(question)
    await userEvent.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!)
    expect(other.close).toHaveBeenCalledWith()
  })

  it('will not confirm with nothing selected when nothing is suggested', () => {
    setup({ question: { ...question.question, suggested: undefined } as QuestionDialogInput['question'] })
    expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled()
  })
})

describe('a currency', () => {
  it('starts from the suggestion, accepts three letters upper-cased, and nothing else', async () => {
    const { close } = setup({ question: { kind: 'currency', id: 'exchange.import.currency', title: 'Which currency?', suggested: 'CAD' } })
    const field = screen.getByRole('textbox', { name: 'Currency' })
    expect(field).toHaveValue('CAD')
    await userEvent.clear(field)
    expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled()
    await userEvent.type(field, 'eur')
    expect(field).toHaveValue('EUR')
    await userEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(close).toHaveBeenCalledWith('EUR')
  })
})
