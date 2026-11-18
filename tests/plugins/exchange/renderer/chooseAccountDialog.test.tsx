// Choosing the account a statement belongs to: one of the book's accounts, or a new one prefilled from the
// statement, with the answer remembered so the next import of this source asks nothing.
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChooseAccountInput } from '@tessera/exchange-api'
import ChooseAccountDialog from '../../../../plugins/exchange/src/renderer/ChooseAccountDialog'

function setup(over: Partial<ChooseAccountInput> = {}) {
  const close = vi.fn()
  const input: ChooseAccountInput = {
    statement: 'The Maple Trust Bank account ····0099',
    fileName: 'statement.qfx',
    currency: 'CAD',
    accounts: [
      { id: 'a1', name: 'Chequing', number: '1234567890', currency: 'CAD' },
      { id: 'a2', name: 'US savings', currency: 'USD' },
      { id: 'a3', name: 'Old card', currency: 'CAD', closed: true }
    ],
    canCreate: true,
    ...over
  }
  render(<ChooseAccountDialog input={input} close={close} setBusy={() => {}} />)
  return { close }
}

const account = (id: string) => document.querySelector(`[data-account="${id}"]`) as HTMLElement

afterEach(() => { vi.restoreAllMocks() })

describe('what the dialog shows', () => {
  it('names the statement and its file, and lists every account', () => {
    setup()
    expect(screen.getByText(/The Maple Trust Bank account ····0099/)).toBeInTheDocument()
    expect(screen.getByText(/statement\.qfx/)).toBeInTheDocument()
    expect(account('a1')).toBeInTheDocument()
    expect(within(account('a3')).getByText(/closed/)).toBeInTheDocument()
  })

  it('disables an account in another currency, and says why', () => {
    setup()
    expect(account('a2')).toHaveAttribute('aria-disabled', 'true')
    expect(within(account('a2')).getByText(/USD, but the statement is CAD/)).toBeInTheDocument()
  })

  it('offers a new account only when the account dialog is available', () => {
    setup({ canCreate: false })
    expect(document.querySelector('[data-account="create"]')).toBeNull()
  })
})

describe('choosing', () => {
  it('confirms nothing until something is chosen', () => {
    setup()
    expect(screen.getByRole('button', { name: 'Use This Account' })).toBeDisabled()
  })

  it('closes with the chosen account, remembering by default', async () => {
    const { close } = setup()
    await userEvent.click(account('a1'))
    await userEvent.click(screen.getByRole('button', { name: 'Use This Account' }))
    expect(close).toHaveBeenCalledWith({ kind: 'existing', accountId: 'a1', remember: true })
  })

  it('does not remember when the user unticks it', async () => {
    const { close } = setup()
    await userEvent.click(account('a1'))
    await userEvent.click(screen.getByRole('checkbox', { name: /Remember this choice/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Use This Account' }))
    expect(close).toHaveBeenCalledWith({ kind: 'existing', accountId: 'a1', remember: false })
  })

  it('closes asking for a new account when that is chosen', async () => {
    const { close } = setup()
    await userEvent.click(account('create'))
    await userEvent.click(screen.getByRole('button', { name: 'Create Account…' }))
    expect(close).toHaveBeenCalledWith({ kind: 'create', remember: true })
  })

  it('closes with nothing when the statement is skipped', async () => {
    const { close } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Skip This Statement' }))
    expect(close).toHaveBeenCalledWith()
  })
})
