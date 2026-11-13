import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACCOUNTS_CHANNELS, ACCOUNTS_COMMANDS as C, ACCOUNTS_EVENTS,
  type Account, type AccountDialogInput, type Chart, type ResolvedNavigatorItem
} from '@tessera/accounts-api'
import AccountDialog, { toInput } from '../../../../plugins/accounts/src/renderer/AccountDialog'
import MoveDialog from '../../../../plugins/accounts/src/renderer/MoveDialog'
import Navigator, { rowsOf } from '../../../../plugins/accounts/src/renderer/Navigator'
import { createFakeRemote } from '../../../helpers/fakeBridge'

const EXECUTE = 'shell:commands.execute'

const account = (over: Partial<Account>): Account => ({
  id: 'a', rev: 1, name: 'Chequing', type: 'chequing', subBookId: null, currency: 'CAD', openingDate: '2026-01-01',
  openingBalance: 100000, order: 0, closed: false, ...over
})
const summary = (a: Account) => ({ account: a, balances: { current: a.openingBalance, available: a.openingBalance, cleared: a.openingBalance, reconciled: a.openingBalance, transactionCount: 0 } })

// Home
//   Personal          (sub-book)
//     Visa            -540.00
//   Chequing          1,000.00
//   Old (closed)
const CHART: Chart = {
  book: { name: 'Home' },
  subBooks: [{ id: 'p', parentId: null, name: 'Personal', order: 0, totals: { CAD: -54000 } }],
  accounts: [
    summary(account({ id: 'v', name: 'Visa', type: 'creditCard', subBookId: 'p', openingBalance: -54000, institution: 'TD', accountNumber: '4520 1111 2222 9012' })),
    summary(account({ id: 'c', name: 'Chequing', order: 1 })),
    summary(account({ id: 'o', name: 'Old', order: 2, openingBalance: 0, closed: true, closedOn: '2026-06-01' }))
  ],
  totals: { CAD: 46000 }
}

function bridge(answers: Record<string, (data: any) => unknown> = {}) {
  const remote = createFakeRemote({})
  remote.bridge.invoke.mockImplementation(async (channel: string, data?: any) => {
    if (channel === EXECUTE) return undefined
    const answer = answers[channel]
    if (!answer) throw new Error(`No answer for ${channel}`)
    return answer(data)
  })
  ;(window as any).api = remote.bridge
  const calls = (channel: string) => remote.bridge.invoke.mock.calls.filter((c: unknown[]) => c[0] === channel).map((c: unknown[]) => c[1])
  return { ...remote, calls, executed: () => calls(EXECUTE) as { id: string, args: unknown[] }[] }
}

afterEach(() => { delete (window as any).api })

describe('the navigator', () => {
  const setup = (chart: Chart = CHART, items: ResolvedNavigatorItem[] = []) => {
    const b = bridge({
      [ACCOUNTS_CHANNELS.chart]: () => chart,
      [ACCOUNTS_CHANNELS.selection]: () => ({ kind: 'book' }),
      [ACCOUNTS_CHANNELS.select]: () => undefined,
      [ACCOUNTS_CHANNELS.navigatorItems]: () => items
    })
    render(<Navigator />)
    return b
  }
  const item = (name: string) => screen.getByRole('treeitem', { name })

  it('lists sub-books before accounts under each node, with balances, hiding closed accounts', async () => {
    setup()
    const tree = await screen.findByRole('tree', { name: 'Accounts in Home' })
    expect(within(tree).getAllByRole('treeitem').map(i => [i.getAttribute('aria-label'), i.getAttribute('aria-level')]))
      .toEqual([['Home', '1'], ['Personal', '2'], ['Visa', '3'], ['Chequing', '2']])
    // The symbol is the system locale's: "$" in Canada, "CA$" elsewhere
    expect(item('Visa')).toHaveTextContent(/-\S*540\.00/)
    expect(item('Chequing')).toHaveTextContent(/1,000\.00/)
    expect(item('Visa')).toHaveAttribute('title', 'Credit card · TD · •••• 9012')
  })

  it('draws what is owed in red (the theme\'s error colour), the Money way', async () => {
    setup()
    await screen.findByRole('tree')
    expect(item('Visa').querySelector('[data-negative]')).not.toBeNull()
    expect(item('Chequing').querySelector('[data-negative]')).toBeNull()
  })

  // `accounts.navigator.items`: what another plugin (recurring, first) puts in the panel
  const contributed = (over: Partial<ResolvedNavigatorItem> = {}): ResolvedNavigatorItem => ({
    id: 'recurring.navigator.list', label: 'Recurring', command: 'recurring.open', icon: 'Repeat',
    placement: 'bottom', badgeTone: 'error', enabled: true, ...over
  })

  const added = (name: string) => screen.getByRole('button', { name })

  it('draws a contributed row below the tree, outside it, and runs its command when clicked', async () => {
    const b = setup(CHART, [contributed()])
    const tree = await screen.findByRole('tree')
    await waitFor(() => expect(added('Recurring')).toBeTruthy())
    // It is not a node of the book's tree, so the Accounts menu still acts on the tree's own selection
    expect(within(tree).queryByRole('button', { name: 'Recurring' })).toBeNull()
    expect(within(tree).getAllByRole('treeitem').map(i => i.getAttribute('aria-label')))
      .toEqual(['Home', 'Personal', 'Visa', 'Chequing'])

    await userEvent.click(added('Recurring'))
    expect(b.executed()).toEqual([{ id: 'recurring.open', args: [] }])
    expect(b.calls(ACCOUNTS_CHANNELS.select)).toEqual([])
  })

  it('reaches a contributed row by keyboard, and skips a disabled one', async () => {
    const b = setup(CHART, [contributed(), contributed({ id: 'recurring.off', label: 'Later', enabled: false })])
    await screen.findByRole('tree')
    await waitFor(() => expect(added('Recurring')).toBeTruthy())

    expect(added('Recurring')).toHaveAttribute('tabindex', '0')
    expect(added('Later')).toHaveAttribute('tabindex', '-1')
    added('Recurring').focus()
    await userEvent.keyboard('{Enter}')
    expect(b.executed()).toEqual([{ id: 'recurring.open', args: [] }])

    await userEvent.click(added('Later'))
    expect(b.executed()).toHaveLength(1)
  })

  it('places a top row above the book, and shows its badge', async () => {
    setup(CHART, [contributed({ placement: 'top', badge: '3' })])
    await screen.findByRole('tree')
    await waitFor(() => expect(added('Recurring')).toBeTruthy())
    expect(added('Recurring')).toHaveTextContent('3')
    // Before the book row in document order
    expect(added('Recurring').compareDocumentPosition(item('Home'))).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('updates a contributed badge when the plugin pushes the list again', async () => {
    const b = setup(CHART, [contributed()])
    await screen.findByRole('tree')
    await waitFor(() => expect(added('Recurring')).toBeTruthy())
    expect(added('Recurring')).not.toHaveTextContent('2')

    act(() => { b.emit(ACCOUNTS_EVENTS.navigatorItems, [contributed({ badge: '2' })]) })
    await waitFor(() => expect(added('Recurring')).toHaveTextContent('2'))
  })

  it('shows closed accounts when asked, dimmed', async () => {
    setup()
    await screen.findByRole('tree')
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }))
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Show closed accounts' }))
    expect(item('Old')).toHaveAttribute('data-closed', 'true')
  })

  it('tells the plugin what is selected, shows a clicked account\'s register, and runs commands on it', async () => {
    const b = setup()
    await screen.findByRole('tree')
    await userEvent.click(item('Chequing'))
    expect(b.calls(ACCOUNTS_CHANNELS.select).at(-1)).toEqual({ kind: 'account', id: 'c' })
    // One click opens the register, once the plugin has the selection
    await waitFor(() => expect(b.executed()).toEqual([{ id: C.showRegister, args: [{ id: 'c' }] }]))

    await userEvent.click(screen.getByRole('button', { name: 'Edit account' }))
    await userEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    await userEvent.click(screen.getByRole('button', { name: 'New account' }))
    expect(b.executed().slice(1)).toEqual([
      { id: C.editAccount, args: [{ id: 'c' }] }, { id: C.deleteAccount, args: [{ id: 'c' }] }, { id: C.newAccount, args: [] }
    ])
  })

  it('moves the selection with the arrow keys without opening registers; Enter opens one', async () => {
    const b = setup()
    await screen.findByRole('tree')
    item('Home').focus()
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
    await waitFor(() => expect(item('Chequing')).toHaveAttribute('aria-selected', 'true'))
    expect(b.executed()).toEqual([])
    await userEvent.keyboard('{Enter}')
    expect(b.executed()).toEqual([{ id: C.showRegister, args: [{ id: 'c' }] }])
  })

  it('offers an account\'s reconciliation options in its context menu, showing its register first', async () => {
    const b = bridge({
      [ACCOUNTS_CHANNELS.chart]: () => CHART,
      [ACCOUNTS_CHANNELS.selection]: () => ({ kind: 'book' }),
      [ACCOUNTS_CHANNELS.select]: () => undefined,
      [ACCOUNTS_CHANNELS.reconcileActions]: () => [
        { id: 'accounts.reconcile.statement', label: 'Reconcile with Statement…', scope: 'account', command: C.reconcileStatement, icon: 'Check', enabled: false }
      ]
    })
    render(<Navigator />)
    await screen.findByRole('tree')
    await userEvent.pointer({ keys: '[MouseRight]', target: item('Visa') })
    expect(b.calls(ACCOUNTS_CHANNELS.reconcileActions)).toEqual([{ accountId: 'v', scope: 'account' }])
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Reconcile with Statement…' }))
    await waitFor(() => expect(b.executed()).toEqual([
      { id: C.showRegister, args: [{ id: 'v' }] }, { id: C.reconcileStatement, args: [{ accountId: 'v' }] }
    ]))
  })

  it('renames and deletes a selected sub-book through the sub-book commands, by key', async () => {
    const b = setup()
    await screen.findByRole('tree')
    await userEvent.click(item('Personal'))
    item('Personal').focus()
    await userEvent.keyboard('{F2}{Delete}')
    expect(b.executed()).toEqual([{ id: C.renameSubBook, args: [{ id: 'p' }] }, { id: C.deleteSubBook, args: [{ id: 'p' }] }])
  })

  it('offers the right actions in a row\'s context menu', async () => {
    const b = setup()
    await screen.findByRole('tree')
    await userEvent.pointer({ keys: '[MouseRight]', target: item('Visa') })
    const menu = screen.getByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map(i => i.textContent)).toEqual([
      'New Account…', 'New Sub-Book…', 'Open Register', 'Edit Account…', 'Close Account…', 'Move To…', 'Delete Account…'
    ])
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Close Account…' }))
    expect(b.executed()).toEqual([{ id: C.closeAccount, args: [{ id: 'v' }] }])
  })

  it('follows the chart and a selection a command announced', async () => {
    const b = setup()
    await screen.findByRole('tree')
    const chart = { ...CHART, accounts: [...CHART.accounts, summary(account({ id: 'n', name: 'New', order: 3 }))] }
    act(() => b.emit(ACCOUNTS_EVENTS.chart, chart))
    act(() => b.emit(ACCOUNTS_EVENTS.selection, { kind: 'account', id: 'n' }))
    await waitFor(() => expect(item('New')).toHaveAttribute('aria-selected', 'true'))
  })

  it('builds rows with per-currency totals on sub-books', () => {
    const rows = rowsOf(CHART, { collapsed: new Set(), showClosed: false })
    expect(rows.find(r => r.key === 'p')).toMatchObject({ kind: 'subBook', totals: { CAD: -54000 }, hasChildren: true })
    expect(rowsOf(CHART, { collapsed: new Set(['p']), showClosed: true }).map(r => r.name)).toEqual(['Home', 'Personal', 'Chequing', 'Old'])
  })
})

describe('the account dialog', () => {
  const base = { subBooks: CHART.subBooks, bookName: 'Home', defaultCurrency: 'CAD' }
  const setup = (input: AccountDialogInput, save: (data: any) => unknown = data => ({ ok: true, value: { ...data.input, id: data.id ?? 'new' } })) => {
    const b = bridge({ [ACCOUNTS_CHANNELS.saveAccount]: save })
    const close = vi.fn()
    const setBusy = vi.fn()
    render(<AccountDialog input={input} close={close} setBusy={setBusy} />)
    return { ...b, close, setBusy }
  }
  const field = (name: string) => screen.getByRole('textbox', { name })

  it('creates an account where it was asked to, with what was typed, in minor units', async () => {
    const { calls, close } = setup({ ...base, mode: 'create', subBookId: 'p' })
    expect(screen.getByRole('combobox', { name: 'In' })).toHaveTextContent('Personal')
    await userEvent.type(field('Name'), 'Everyday')
    await userEvent.clear(field('Opening balance'))
    await userEvent.type(field('Opening balance'), '1,234.56')
    await userEvent.type(field('Institution'), 'TD')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(calls(ACCOUNTS_CHANNELS.saveAccount)).toEqual([{ input: expect.objectContaining({
      name: 'Everyday', type: 'chequing', subBookId: 'p', currency: 'CAD', openingBalance: 123456, institution: 'TD'
    }) }])
    expect(close).toHaveBeenCalledWith({ id: 'new' })
  })

  it('asks for the amount owed on a credit card, stores it negative, and takes a credit limit', () => {
    const form = { name: 'Visa', type: 'creditCard' as const, subBook: '(book)', currency: 'CAD', openingDate: '2026-01-01', openingBalance: '540', creditLimit: '5,000', minimumBalance: '', showAvailableBalance: false, institution: '', accountNumber: '', notes: '' }
    expect(toInput(form).input).toMatchObject({ openingBalance: -54000, creditLimit: 500000, subBookId: null })
    expect(toInput({ ...form, type: 'chequing' }).input).not.toHaveProperty('creditLimit')
    expect(toInput({ ...form, openingBalance: '5.555' }).problems).toEqual({ openingBalance: 'Use at most 2 decimal places.' })
  })

  it('relabels the balance for a liability, and shows the credit limit only for cards and lines of credit', async () => {
    setup({ ...base, mode: 'create', subBookId: null })
    expect(screen.queryByRole('textbox', { name: 'Credit limit' })).toBeNull()
    await userEvent.click(screen.getByRole('combobox', { name: 'Type' }))
    await userEvent.click(screen.getByRole('option', { name: 'Credit card' }))
    expect(field('Amount owed')).toBeInTheDocument()
    expect(field('Credit limit')).toBeInTheDocument()
  })

  it('edits an account, showing what a liability owes as a positive amount, and sends its revision', async () => {
    const visa = account({ id: 'v', rev: 7, name: 'Visa', type: 'creditCard', openingBalance: -54000, creditLimit: 500000, notes: 'Travel' })
    const { calls, close } = setup({ ...base, mode: 'edit', account: visa })
    expect(field('Amount owed')).toHaveValue('540.00')
    expect(field('Credit limit')).toHaveValue('5000.00')
    await userEvent.clear(field('Notes'))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    const [request] = calls(ACCOUNTS_CHANNELS.saveAccount) as any[]
    expect(request).toMatchObject({ id: 'v', expectedRev: 7, input: { openingBalance: -54000, creditLimit: 500000 } })
    expect(request.input).not.toHaveProperty('notes')
    expect(close).toHaveBeenCalledWith({ id: 'v' })
  })

  it('shows problems on their fields, before sending and after', async () => {
    const { calls, close } = setup({ ...base, mode: 'create', subBookId: null },
      () => ({ ok: false, error: { code: 'DUPLICATE_NAME', message: 'There is already an account named “Chequing”.', field: 'name' } }))
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(screen.getByText('Enter a name.')).toBeInTheDocument()
    expect(calls(ACCOUNTS_CHANNELS.saveAccount)).toEqual([])

    await userEvent.type(field('Name'), 'chequing{Enter}')
    expect(await screen.findByText('There is already an account named “Chequing”.')).toBeInTheDocument()
    expect(field('Name')).toHaveAttribute('aria-invalid', 'true')
    expect(close).not.toHaveBeenCalled()
  })
})

describe('the move dialog', () => {
  const subBooks = [
    { id: 'a', parentId: null, name: 'A', order: 0, totals: {} },
    { id: 'b', parentId: 'a', name: 'B', order: 0, totals: {} },
    { id: 'x', parentId: null, name: 'X', order: 1, totals: {} }
  ]

  it('offers every place but the current one, and moves there', async () => {
    const b = bridge({ [ACCOUNTS_CHANNELS.move]: () => ({ ok: true }) })
    const close = vi.fn()
    render(<MoveDialog input={{ item: { kind: 'account', id: 'c', name: 'Chequing', parentId: null }, subBooks, bookName: 'Home' }} close={close} setBusy={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled()
    await userEvent.click(screen.getByRole('combobox', { name: 'Move to' }))
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['Home', 'A', 'B', 'X'])
    await userEvent.click(screen.getByRole('option', { name: 'B' }))
    await userEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(b.calls(ACCOUNTS_CHANNELS.move)).toEqual([{ kind: 'account', id: 'c', to: 'b' }])
    expect(close).toHaveBeenCalledWith({ to: 'b' })
  })

  it('never offers a sub-book a place inside itself, and shows why a move failed', async () => {
    bridge({ [ACCOUNTS_CHANNELS.move]: () => ({ ok: false, error: { code: 'INVALID', message: 'There is already a “A” there.' } }) })
    render(<MoveDialog input={{ item: { kind: 'subBook', id: 'a', name: 'A', parentId: null }, subBooks, bookName: 'Home' }} close={vi.fn()} setBusy={vi.fn()} />)
    await userEvent.click(screen.getByRole('combobox', { name: 'Move to' }))
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['Home', 'X'])
    await userEvent.click(screen.getByRole('option', { name: 'X' }))
    await userEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('There is already a “A” there.')
  })
})
