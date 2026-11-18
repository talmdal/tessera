// The payee rules list. Order is the semantics — the first rule that fires wins — so most of what this dialog
// has to get right is that the list the user sees is the order the pipeline will use.
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { PayeeRule, RulesDialogInput } from '@tessera/exchange-api'
import RulesDialog from '../../../../plugins/exchange/src/renderer/RulesDialog'

const rule = (over: Partial<PayeeRule> = {}): PayeeRule => ({
  id: 'r1', order: 0, match: { kind: 'startsWith', value: 'SQ *THE DAILY GRIND', ignoreCase: true },
  payee: 'The Daily Grind', enabled: true, rev: 1, ...over
})

const input = (over: Partial<RulesDialogInput> = {}): RulesDialogInput => ({
  rules: [rule()],
  categories: [{ id: 'c1', label: 'Food : Dining out' }],
  accounts: [{ id: 'a1', name: 'Chequing' }],
  ...over
})

function setup(over: Partial<RulesDialogInput> = {}) {
  const close = vi.fn()
  render(<RulesDialog input={input(over)} close={close} setBusy={() => {}} />)
  return { close }
}

const save = () => screen.getByRole('button', { name: 'Save' })
const bodyRows = () => within(screen.getByRole('table', { name: 'Payee rules' })).getAllByRole('row').slice(1)

describe('the list', () => {
  it('shows each rule with what it matches and what it renames to', () => {
    setup()
    expect(screen.getByLabelText('Rule 1 text')).toHaveValue('SQ *THE DAILY GRIND')
    expect(screen.getByLabelText('Rule 1 payee')).toHaveValue('The Daily Grind')
    expect(screen.getByLabelText('Rule 1 test')).toHaveTextContent('starts with')
  })

  it('shows the rules in their order, not the order they happened to arrive in', () => {
    setup({
      rules: [
        rule({ id: 'r2', order: 1, payee: 'Second' }),
        rule({ id: 'r1', order: 0, payee: 'First' })
      ]
    })
    expect(screen.getByLabelText('Rule 1 payee')).toHaveValue('First')
    expect(screen.getByLabelText('Rule 2 payee')).toHaveValue('Second')
  })

  it('marks a rule that was learned from “Always rename this”', () => {
    setup({ rules: [rule({ learned: true })] })
    expect(screen.getByText('learned')).toBeInTheDocument()
  })

  it('explains itself when there are no rules yet', () => {
    setup({ rules: [] })
    expect(screen.getByText(/No rules yet/)).toBeInTheDocument()
    expect(bodyRows()).toHaveLength(1)
  })
})

describe('editing', () => {
  it('saves a changed name', async () => {
    const { close } = setup()
    await userEvent.clear(screen.getByLabelText('Rule 1 payee'))
    await userEvent.type(screen.getByLabelText('Rule 1 payee'), 'Daily Grind')
    await userEvent.click(save())
    expect(close.mock.calls[0][0].rules[0]).toMatchObject({ payee: 'Daily Grind' })
  })

  it('switches a rule off without deleting it', async () => {
    const { close } = setup()
    await userEvent.click(screen.getByLabelText('Rule 1 on'))
    await userEvent.click(save())
    expect(close.mock.calls[0][0].rules[0]).toMatchObject({ enabled: false })
  })

  it('adds a rule, and drops it again if it was left unfinished', async () => {
    const { close } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Add Rule' }))
    expect(screen.getByLabelText('Rule 2 text')).toBeInTheDocument()
    expect(screen.getByText(/1 unfinished rule will be dropped/)).toBeInTheDocument()

    await userEvent.click(save())
    // A rule with nothing to match on would fire on everything, so it is not saved.
    expect(close.mock.calls[0][0].rules).toHaveLength(1)
  })

  it('keeps a new rule once it has both halves', async () => {
    const { close } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Add Rule' }))
    await userEvent.type(screen.getByLabelText('Rule 2 text'), 'AMZN MKTP')
    await userEvent.type(screen.getByLabelText('Rule 2 payee'), 'Amazon')
    await userEvent.click(save())

    expect(close.mock.calls[0][0].rules).toHaveLength(2)
    expect(close.mock.calls[0][0].rules[1]).toMatchObject({
      match: { kind: 'contains', value: 'AMZN MKTP' }, payee: 'Amazon', enabled: true
    })
  })

  it('deletes a rule', async () => {
    const { close } = setup()
    await userEvent.click(screen.getByLabelText('Delete rule 1'))
    await userEvent.click(save())
    expect(close.mock.calls[0][0].rules).toEqual([])
  })

  it('scopes a rule to one account, and picks a category', async () => {
    const { close } = setup()
    await userEvent.click(screen.getByLabelText('Rule 1 account'))
    await userEvent.click(screen.getByRole('option', { name: 'Chequing' }))
    await userEvent.click(screen.getByLabelText('Rule 1 category'))
    await userEvent.click(screen.getByRole('option', { name: 'Food : Dining out' }))
    await userEvent.click(save())

    expect(close.mock.calls[0][0].rules[0]).toMatchObject({ accountId: 'a1', categoryId: 'c1' })
  })
})

describe('order', () => {
  const two = { rules: [rule({ id: 'r1', order: 0, payee: 'First' }), rule({ id: 'r2', order: 1, payee: 'Second' })] }

  it('moves a rule down, and renumbers from the position so nothing can disagree', async () => {
    const { close } = setup(two)
    await userEvent.click(screen.getByLabelText('Move rule 1 down'))
    expect(screen.getByLabelText('Rule 1 payee')).toHaveValue('Second')

    await userEvent.click(save())
    expect(close.mock.calls[0][0].rules.map((r: PayeeRule) => [r.payee, r.order]))
      .toEqual([['Second', 0], ['First', 1]])
  })

  it('moves a rule up', async () => {
    const { close } = setup(two)
    await userEvent.click(screen.getByLabelText('Move rule 2 up'))
    await userEvent.click(save())
    expect(close.mock.calls[0][0].rules[0]).toMatchObject({ payee: 'Second' })
  })

  it('cannot move the first up or the last down', () => {
    setup(two)
    expect(screen.getByLabelText('Move rule 1 up')).toBeDisabled()
    expect(screen.getByLabelText('Move rule 2 down')).toBeDisabled()
  })
})

describe('cancelling', () => {
  it('closes with nothing, so the book’s rules are untouched', async () => {
    const { close } = setup()
    await userEvent.clear(screen.getByLabelText('Rule 1 payee'))
    await userEvent.type(screen.getByLabelText('Rule 1 payee'), 'Changed')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(close).toHaveBeenCalledWith()
  })
})

describe('a pattern that is not valid', () => {
  // Before, the dialog saved it, the service refused the whole list, and every other edit was lost.
  it('holds Save and says so, instead of losing every edit made in the dialog', async () => {
    const { close } = setup()
    await userEvent.clear(screen.getByLabelText('Rule 1 payee'))
    await userEvent.type(screen.getByLabelText('Rule 1 payee'), 'Daily Grind')

    await userEvent.click(screen.getByLabelText('Rule 1 test'))
    await userEvent.click(screen.getByRole('option', { name: 'matches pattern' }))
    await userEvent.clear(screen.getByLabelText('Rule 1 text'))
    await userEvent.type(screen.getByLabelText('Rule 1 text'), 'SQ *({[}')

    expect(save()).toBeDisabled()
    expect(screen.getByText(/pattern that is not valid/)).toBeInTheDocument()
    expect(close).not.toHaveBeenCalled()

    // Fixed, it saves — with the other edit intact.
    await userEvent.clear(screen.getByLabelText('Rule 1 text'))
    await userEvent.type(screen.getByLabelText('Rule 1 text'), '^SQ \\*')
    await userEvent.click(save())
    expect(close.mock.calls[0][0].rules[0]).toMatchObject({ payee: 'Daily Grind', match: { kind: 'regex' } })
  })
})
