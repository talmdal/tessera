// The Budget Line dialog: what a new line is for (categories, transfers, a new category), amounts parsed in the
// budget's currency, how often and when it is due, the preview of the budget year, and for an edit, a change from a
// month on or for that month only, a later change kept or replaced, and a line changed elsewhere.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  BUDGET_CHANNELS, type AddLineRequest, type BudgetLine, type ChangeLineRequest, type LineDialogInput, type TargetChoice
} from '@tessera/budget-api'
import LineDialog from '../../../../plugins/budget/src/renderer/LineDialog'
import { checkForm, initialForm, preview } from '../../../../plugins/budget/src/renderer/lineForm'
import { BUDGET, budgetBridge, renderInTheme } from './fixtures'

const CHOICES: TargetChoice[] = [
  { target: { kind: 'category', categoryId: 'groceries' }, group: 'expense', label: 'Food : Groceries' },
  { target: { kind: 'category', categoryId: 'insurance' }, group: 'expense', label: 'Housing : Home insurance' },
  { target: { kind: 'category', categoryId: 'salary' }, group: 'income', label: 'Salary' },
  { target: { kind: 'transfer', accountId: 'bchq', direction: 'in' }, group: 'income', label: 'Transfers from: Business Chequing' },
  { target: { kind: 'transfer', accountId: 'bchq', direction: 'out' }, group: 'expense', label: 'Transfers to: Business Chequing' }
]
const NEW: LineDialogInput = { budget: BUDGET, month: '2027-03', choices: CHOICES, canCreateCategory: true }
const GROCERIES: BudgetLine = {
  id: 'l-groceries', budgetId: BUDGET.id, target: { kind: 'category', categoryId: 'groceries' }, rev: 3,
  plans: [{ from: '2027-01', amount: 65000, frequency: 'monthly', due: '2027-01' }]
}
const EDIT: LineDialogInput = { budget: BUDGET, month: '2027-03', line: GROCERIES, label: 'Food : Groceries', group: 'expense' }

function open(input: LineDialogInput, answers: Parameters<typeof budgetBridge>[0] = {}) {
  const bridge = budgetBridge({
    [BUDGET_CHANNELS.addLine]: (data: AddLineRequest) => ({ ok: true, value: { ...GROCERIES, id: 'new', target: data.input.target, plans: [data.input.plan] } }),
    [BUDGET_CHANNELS.changeLine]: (data: ChangeLineRequest) => ({ ok: true, value: { ...GROCERIES, id: data.lineId } }),
    ...answers
  })
  const close = vi.fn()
  renderInTheme(<LineDialog input={input} close={close} setBusy={vi.fn()} />)
  return { ...bridge, close, user: userEvent.setup() }
}

const previewOf = () => Object.fromEntries([...document.querySelectorAll('[data-preview-month]')].map(m => [m.getAttribute('data-preview-month'), m.textContent]))
const field = (name: string) => screen.getByRole('textbox', { name })
async function paste(user: ReturnType<typeof userEvent.setup>, element: HTMLElement, text: string) {
  await user.clear(element)
  await user.click(element)
  await user.paste(text)
}
async function choose(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole('combobox', { name: 'For' }))
  await user.click(await screen.findByRole('option', { name: label }))
}

describe('the Budget Line dialog: a new line', () => {
  it('adds a line for a category, every month with no particular day from the month shown, with a preview of the year', async () => {
    const { user, calls, close } = open(NEW)
    await choose(user, 'Food : Groceries')
    await paste(user, field('Amount'), '1,234.5')
    expect(screen.getByRole('checkbox', { name: 'No particular day' })).toBeChecked()
    expect(previewOf()).toMatchObject({ '2027-01': 'Jan—', '2027-02': 'Feb—', '2027-03': 'Mar1,234.50', '2027-12': 'Dec1,234.50' })
    expect(document.querySelector('[data-preview-total]')).toHaveTextContent('Year 12,345.00')
    await user.click(screen.getByRole('button', { name: 'Add Line' }))
    expect(calls(BUDGET_CHANNELS.addLine)).toEqual([{ budgetId: BUDGET.id, input: {
      target: { kind: 'category', categoryId: 'groceries' }, plan: { from: '2027-03', amount: 123450, frequency: 'monthly', due: '2027-03' }
    } }])
    await waitFor(() => expect(close).toHaveBeenCalledWith({ id: 'new' }))
  })

  it('lists transfers with accounts outside the budget, and plans the owner\'s pay from the business', async () => {
    const { user, calls } = open(NEW)
    await user.click(screen.getByRole('combobox', { name: 'For' }))
    const list = await screen.findByRole('listbox')
    expect(within(list).getAllByRole('option').map(o => o.textContent)).toEqual([
      'Food : Groceries', 'Housing : Home insurance', 'Salary', 'Transfers from: Business Chequing', 'Transfers to: Business Chequing'
    ])
    await user.click(within(list).getByRole('option', { name: 'Transfers from: Business Chequing' }))
    await paste(user, field('Amount'), '3000')
    await user.click(screen.getByRole('checkbox', { name: 'No particular day' }))
    await paste(user, screen.getByLabelText('First due'), '2027-01-25')
    expect(previewOf()['2027-03']).toBe('Mar3,000.00 (due 25)')
    await user.click(screen.getByRole('button', { name: 'Add Line' }))
    await waitFor(() => expect(calls(BUDGET_CHANNELS.addLine)[0].input).toEqual({
      target: { kind: 'transfer', accountId: 'bchq', direction: 'in' }, plan: { from: '2027-03', amount: 300000, frequency: 'monthly', due: '2027-01-25' }
    }))
  })

  it('plans every two weeks from a date, three times in a month with three paydays, and needs the date', async () => {
    const { user } = open(NEW)
    await choose(user, 'Salary')
    await paste(user, field('Amount'), '2100')
    await user.click(screen.getByRole('combobox', { name: 'How often' }))
    await user.click(await screen.findByRole('option', { name: 'Every two weeks' }))
    // A weekly or fortnightly plan always has a day
    expect(screen.getByRole('checkbox', { name: 'No particular day' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'No particular day' })).not.toBeChecked()
    await paste(user, screen.getByLabelText('First due'), '2027-01-08')
    expect(previewOf()['2027-04']).toBe('Apr6,300.00 (due 2, 16, 30)')
    expect(previewOf()['2027-03']).toBe('Mar4,200.00 (due 5, 19)')
  })

  it('plans a yearly bill due on a date', async () => {
    const { user } = open(NEW)
    await choose(user, 'Housing : Home insurance')
    await paste(user, field('Amount'), '1200')
    await user.click(screen.getByRole('combobox', { name: 'How often' }))
    await user.click(await screen.findByRole('option', { name: 'Every year' }))
    await user.click(screen.getByRole('checkbox', { name: 'No particular day' }))
    await paste(user, screen.getByLabelText('First due'), '2027-03-15')
    expect(previewOf()).toMatchObject({ '2027-03': 'Mar1,200.00 (due 15)', '2027-04': 'Apr—' })
    expect(document.querySelector('[data-preview-total]')).toHaveTextContent('Year 1,200.00')
  })

  it('makes a category, asking whether it is income or spending', async () => {
    const { user, calls } = open(NEW, {
      [BUDGET_CHANNELS.createCategory]: () => ({ ok: true, value: { id: 'pets', name: 'Pets', kind: 'expense', parentId: null, rev: 1 } })
    })
    await user.click(screen.getByRole('combobox', { name: 'For' }))
    await user.paste('Pets')
    expect(screen.getByRole('option', { name: 'Create income category “Pets”' })).toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: 'Create expense category “Pets”' }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'For' })).toHaveValue('Pets'))
    expect(calls(BUDGET_CHANNELS.createCategory)).toEqual([{ path: 'Pets', kind: 'expense' }])
    await paste(user, field('Amount'), '40')
    await user.click(screen.getByRole('button', { name: 'Add Line' }))
    await waitFor(() => expect(calls(BUDGET_CHANNELS.addLine)[0].input.target).toEqual({ kind: 'category', categoryId: 'pets' }))
  })

  it('says what is missing or wrong, and shows the service\'s problem on its field', async () => {
    const { user, calls, close } = open(NEW, {
      [BUDGET_CHANNELS.addLine]: () => ({ ok: false, error: { code: 'DUPLICATE_LINE', message: '“Groceries” already has a line in this budget.', field: 'target' } })
    })
    await user.click(screen.getByRole('button', { name: 'Add Line' }))
    expect(screen.getByText('Choose what the line is for.')).toBeInTheDocument()
    expect(screen.getByText('Enter an amount.')).toBeInTheDocument()
    await paste(user, field('Amount'), '-5')
    expect(screen.getByText('Enter an amount of zero or more.')).toBeInTheDocument()
    expect(calls(BUDGET_CHANNELS.addLine)).toEqual([])
    await choose(user, 'Food : Groceries')
    await paste(user, field('Amount'), '5')
    await user.click(screen.getByRole('button', { name: 'Add Line' }))
    expect(await screen.findByText('“Groceries” already has a line in this budget.')).toBeInTheDocument()
    expect(close).not.toHaveBeenCalled()
  })
})

describe('the Budget Line dialog: a change', () => {
  it('starts from the plan of the month shown, and applies a new amount from that month on', async () => {
    const { user, calls, close } = open(EDIT)
    expect(document.querySelector('[data-line-for]')).toHaveTextContent('For Food : Groceries')
    expect(field('Amount')).toHaveValue('650.00')
    expect(document.querySelector('[data-apply]')).toBeNull()               // nothing to apply until the plan changes
    await paste(user, field('Amount'), '700')
    expect(screen.getByRole('radio', { name: 'From' })).toBeChecked()
    expect(screen.getByLabelText('Apply from')).toHaveValue('2027-03')
    expect(previewOf()).toMatchObject({ '2027-02': 'Feb650.00', '2027-03': 'Mar700.00' })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls(BUDGET_CHANNELS.changeLine)).toEqual([{
      lineId: 'l-groceries', expectedRev: 3, change: { apply: 'from', plan: { from: '2027-03', amount: 70000, frequency: 'monthly', due: '2027-01' } }
    }])
    await waitFor(() => expect(close).toHaveBeenCalledWith({ id: 'l-groceries' }))
  })

  it('sets the month shown only, and allows only an amount for a single month', async () => {
    const { user, calls } = open(EDIT)
    await paste(user, field('Amount'), '900')
    await user.click(screen.getByRole('radio', { name: 'March 2027 only' }))
    expect(previewOf()).toMatchObject({ '2027-03': 'Mar900.00 •', '2027-04': 'Apr650.00' })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls(BUDGET_CHANNELS.changeLine)[0]).toEqual({ lineId: 'l-groceries', expectedRev: 3, change: { apply: 'only', month: '2027-03', amount: 90000 } })
  })

  it('keeps a later change unless asked to replace it, and saves notes alone', async () => {
    const line: BudgetLine = { ...GROCERIES, plans: [...GROCERIES.plans, { from: '2027-06', amount: 80000, frequency: 'monthly', due: '2027-06' }] }
    const { user, calls } = open({ ...EDIT, line })
    await paste(user, field('Amount'), '700')
    expect(previewOf()['2027-06']).toBe('Jun800.00')
    await user.click(screen.getByRole('checkbox', { name: 'Replace the later change, from June 2027' }))
    expect(previewOf()['2027-06']).toBe('Jun700.00')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls(BUDGET_CHANNELS.changeLine)[0].change).toMatchObject({ apply: 'from', replaceLater: true })
  })

  it('changes only the notes when nothing else changed', async () => {
    const { user, calls } = open({ ...EDIT, line: { ...GROCERIES, notes: 'Weekly shop' } })
    await user.clear(field('Notes'))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls(BUDGET_CHANNELS.changeLine)).toEqual([{ lineId: 'l-groceries', expectedRev: 3, notes: null }])
  })

  it('reloads a line changed elsewhere, keeping what was typed, and saves against the new revision', async () => {
    let conflict = true
    const { user, calls, close } = open(EDIT, {
      [BUDGET_CHANNELS.changeLine]: (data: ChangeLineRequest) => conflict
        ? { ok: false, error: { code: 'CONFLICT', message: 'This was changed elsewhere. Try again.' } }
        : { ok: true, value: { ...GROCERIES, id: data.lineId } },
      [BUDGET_CHANNELS.line]: () => ({ ok: true, value: { ...GROCERIES, rev: 4, notes: 'Changed' } })
    })
    await paste(user, field('Amount'), '700')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/This line was changed elsewhere/)).toBeInTheDocument()
    expect(field('Amount')).toHaveValue('700')
    expect(close).not.toHaveBeenCalled()
    conflict = false
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(close).toHaveBeenCalled())
    expect(calls(BUDGET_CHANNELS.changeLine).at(-1)).toMatchObject({ expectedRev: 4 })
  })
})

describe('the Budget Line dialog\'s form', () => {
  it('checks plans as the service does, and previews them with its functions', () => {
    const form = { ...initialForm(NEW), amount: '10', frequency: 'twiceAMonth' as const, noDay: false, due: '2027-03-20', secondDay: '20' }
    expect(checkForm(form, 'CAD', { needsTarget: false }).problems).toEqual({ secondDay: 'Choose a second day other than the first.' })
    const plan = checkForm({ ...form, secondDay: '' }, 'CAD', { needsTarget: false }).plan!
    expect(plan).toEqual({ from: '2027-03', amount: 1000, frequency: 'twiceAMonth', due: '2027-03-20' })
    expect(preview({ plans: [plan] }, '2027-03', 1).months[3]).toEqual({ month: '2027-04', amount: 2000, due: ['2027-04-05', '2027-04-20'], own: false })
    expect(checkForm({ ...form, amount: '1000000000000' }, 'CAD', { needsTarget: false }).problems).toEqual({ amount: 'That amount is too large for a budget.' })
  })
})
