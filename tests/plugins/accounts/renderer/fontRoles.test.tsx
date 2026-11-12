// The accounts plugin's views draw their text through the font roles: amounts in the Amounts and figures role, tables
// sized in em of the Tables and registers role, names in the navigator that stay readable with large text.
import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  ACCOUNTS_CHANNELS, type Account, type Chart, type ReconcileState, type RegisterSnapshot, type Transaction
} from '@tessera/accounts-api'
import Navigator from '../../../../plugins/accounts/src/renderer/Navigator'
import ReconcilePanel from '../../../../plugins/accounts/src/renderer/reconcile/ReconcilePanel'
import Register from '../../../../plugins/accounts/src/renderer/register/Register'
import { createFakeRemote } from '../../../helpers/fakeBridge'
import { isFigure, renderInShell as inShell } from '../../../helpers/fonts'

const account = (over: Partial<Account> = {}): Account => ({
  id: 'c', rev: 1, name: 'Chequing', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01',
  openingBalance: 100000, order: 0, closed: false, ...over
})
const tx = (over: Partial<Transaction>): Transaction => ({
  id: 't', rev: 1, accountId: 'c', date: '2026-10-02', amount: -5000, status: 'uncleared', voided: false, createdAt: '', updatedAt: '', ...over
})
const snapshot: RegisterSnapshot = {
  account: account(),
  rows: [
    { transaction: tx({ id: 'a', amount: -5025, status: 'cleared' }), balance: 94975, available: 94975, payeeName: 'Metro' },
    { transaction: tx({ id: 'b', date: '2026-10-04', amount: 300000 }), balance: 394975, available: 394975, payeeName: 'Employer' }
  ],
  balances: { current: 394975, available: 394975, cleared: 94975, reconciled: 100000, transactionCount: 2 }
}
const reconciling: ReconcileState = {
  account: account(),
  reconciliation: {
    id: 'r', rev: 1, accountId: 'c', reconcilerId: 'accounts.reconcile.statement', paused: false, addedIds: [], startedAt: '',
    statementDate: '2026-10-31', startingBalance: 100000, statementBalance: 94975
  },
  summary: { starting: 100000, marked: -5025, markedCount: 1, difference: 0, lastReconciledBalance: 100000, adjustment: 0 },
  candidates: [{ transaction: snapshot.rows[0].transaction, payeeName: 'Metro', marked: true, afterStatement: false }]
}

function bridge(answers: Record<string, (data: any) => unknown> = {}) {
  const remote = createFakeRemote({})
  const all: Record<string, (data: any) => unknown> = {
    [ACCOUNTS_CHANNELS.registerAccount]: () => ({ accountId: 'c' }),
    [ACCOUNTS_CHANNELS.chart]: () => null,
    [ACCOUNTS_CHANNELS.categories]: () => [],
    [ACCOUNTS_CHANNELS.loadRegister]: () => snapshot,
    [ACCOUNTS_CHANNELS.searchPayees]: () => [],
    [ACCOUNTS_CHANNELS.reconcileState]: () => null,
    [ACCOUNTS_CHANNELS.reconcileActions]: () => [],
    'shell:commands.execute': () => undefined,
    ...answers
  }
  remote.bridge.invoke.mockImplementation(async (channel: string, data?: any) => {
    const answer = all[channel]
    if (!answer) throw new Error(`No answer for ${channel}`)
    return answer(data)
  })
  ;(window as any).api = remote.bridge
}

const style = (el: Element) => getComputedStyle(el)

describe('the register', () => {
  it('sizes its columns and minimum width in em, so they grow with the Tables and registers font', async () => {
    bridge()
    inShell(<Register />)
    const table = await screen.findByRole('table', { name: 'Register of Chequing' })

    const widths = [...table.querySelectorAll('col')].map(col => col.style.width)
    expect(widths.filter(Boolean).length).toBe(6)
    expect(widths.filter(Boolean).every(width => width.endsWith('em'))).toBe(true)
    // 115 px at the shell's 13 px, so nothing moves at the default size
    // Rounded up to four places, so the width at 13 px is never a fraction of a pixel short
    expect(widths[5]).toBe('8.8462em')
    expect(style(table).minWidth).toBe('63.077em')
    // What em is measured by: the table has its cells' size
    expect(style(table).fontSize).toBe('0.9375rem')
  })

  it('draws amounts and balances in the Amounts and figures font', async () => {
    bridge()
    inShell(<Register />)
    await screen.findByRole('table', { name: 'Register of Chequing' })
    const row = document.querySelector('[data-row="a"]') as HTMLElement
    const cells = within(row).getAllByRole('cell')

    expect(cells[5]).toHaveTextContent('50.25')
    expect(isFigure(cells[5])).toBe(true)
    expect(isFigure(within(cells[7]).getByText(/949\.75/))).toBe(true)
    // Text that isn't a figure keeps the table's font
    expect(style(cells[3]).fontFamily).not.toContain('Cascadia')
  })

  it('leaves room in the status column for its letter', async () => {
    bridge()
    inShell(<Register />)
    await screen.findByRole('table', { name: 'Register of Chequing' })
    const row = document.querySelector('[data-row="a"]') as HTMLElement
    const status = within(row).getAllByRole('cell')[0]

    expect(status).toHaveTextContent('C')
    // theme.spacing(0.5): 4 px each side of a 36 px (at 13 px text) column, where MUI's padding is 16
    expect([style(status).paddingLeft, style(status).paddingRight]).toEqual(['4px', '4px'])
  })
})

describe('reconciling', () => {
  it('sizes the list in em and draws its amounts in the Amounts and figures font', async () => {
    bridge({ [ACCOUNTS_CHANNELS.reconcileState]: () => reconciling })
    inShell(<Register />)
    const table = await screen.findByRole('table', { name: 'Reconcile Chequing' })

    expect([...table.querySelectorAll('col')].map(col => col.style.width).filter(Boolean).every(w => w.endsWith('em'))).toBe(true)
    expect(style(table).minWidth).toMatch(/em$/)
    expect(isFigure(within(table).getByTitle('Click to correct the amount'))).toBe(true)
  })

  it("draws the panel's figures in the Amounts and figures font", async () => {
    bridge({ [ACCOUNTS_CHANNELS.reconcileState]: () => reconciling, [ACCOUNTS_CHANNELS.reconcilePause]: () => ({ ok: true }) })
    inShell(<ReconcilePanel />)
    await waitFor(() => expect(document.querySelector('[data-figure="starting"]')).not.toBeNull())

    for (const name of ['starting', 'marked', 'ending', 'difference']) {
      expect({ name, figure: isFigure(document.querySelector(`[data-figure="${name}"]`)!) }).toEqual({ name, figure: true })
    }
  })
})

describe('the navigator', () => {
  const CHART: Chart = {
    ledger: { name: 'Home' }, subLedgers: [], totals: { CAD: 100000 },
    accounts: [{ account: account({ name: 'High Interest Savings' }), balances: { current: 100000, available: 100000, cleared: 100000, reconciled: 100000, transactionCount: 0 } }]
  }

  it('keeps names readable: at least 5 em wide, the tree scrolling sideways rather than squeezing them', async () => {
    bridge({ [ACCOUNTS_CHANNELS.chart]: () => CHART, [ACCOUNTS_CHANNELS.selection]: () => ({ kind: 'ledger' }), [ACCOUNTS_CHANNELS.select]: () => undefined })
    inShell(<Navigator />)
    const tree = await screen.findByRole('tree', { name: 'Accounts in Home' })
    const name = within(screen.getByRole('treeitem', { name: 'High Interest Savings' })).getByText('High Interest Savings')

    expect(style(name).minWidth).toBe('5em')
    expect(style(name).width).toBe('0px')
    // The rows share a box as wide as the widest needs, which the tree scrolls
    const rows = tree.firstElementChild as HTMLElement
    expect(rows.getAttribute('role')).toBe('none')
    expect(style(rows).minWidth).toBe('min-content')
    expect(style(tree).overflow).toBe('auto')
    // The toolbar wraps rather than pushing its first buttons out of the bar
    const newAccount = screen.getByRole('button', { name: 'New account' })
    expect(style(newAccount.closest('.MuiToolbar-root')!).flexWrap).toBe('wrap')
    // Balances too are figures
    expect(isFigure(within(screen.getByRole('treeitem', { name: 'High Interest Savings' })).getByText(/1,000\.00/))).toBe(true)
  })
})
