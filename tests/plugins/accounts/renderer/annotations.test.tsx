// The register drawing other plugins' marks (accounts.register.annotations): the second line, the Review column's
// buttons, the row menu, the review bar with Next, and the keys. The marks arrive merged in the register.load reply.
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  ACCOUNTS_CHANNELS, ACCOUNTS_EVENTS, type Account, type AnnotationAction, type RegisterAnnotations, type RegisterView,
  type ResolvedRowAnnotation, type Transaction
} from '@tessera/accounts-api'
import Register from '../../../../plugins/accounts/src/renderer/register/Register'
import { createFakeRemote } from '../../../helpers/fakeBridge'

const EXECUTE = 'shell:commands.execute'

const account = (over: Partial<Account> = {}): Account => ({
  id: 'c', rev: 1, name: 'Chequing', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01',
  openingBalance: 100000, order: 0, closed: false, ...over
})
const tx = (id: string, date: string, amount: number): Transaction =>
  ({ id, rev: 1, accountId: 'c', date, amount, status: 'uncleared', voided: false, createdAt: '', updatedAt: '' })

const action = (id: string, label: string, extra: Partial<AnnotationAction> = {}): AnnotationAction =>
  ({ id, label, command: `import.review.${id}`, args: { lineIds: [id] }, placement: 'button', ...extra })

const mark = (transactionId: string, over: Partial<ResolvedRowAnnotation> = {}): ResolvedRowAnnotation => ({
  transactionId, review: true, tone: 'info', detail: { parts: [] }, buttons: [], menu: [], ...over
})

/** Four rows; the Keg and Costco are proposed matches, Hydro was added as new, and the salary is unmarked. */
const MARKS: RegisterAnnotations = {
  rows: [
    mark('keg', {
      tone: 'warning', detail: { icon: 'Warning', parts: [{ text: 'Possible match: Oct 3 · THE KEG #12 · ' }, { text: '57.50', emphasis: true }] },
      buttons: [action('accept', 'Accept', { icon: 'Check', tooltip: 'Use the bank’s amount, 57.50' }), action('change', 'Change…', { icon: 'CompareArrows' })],
      menu: [action('why', 'Why this match?', { placement: 'menu' })]
    }),
    mark('costco', { detail: { parts: [{ text: 'Matched to bank line' }] }, buttons: [action('accept2', 'Accept'), action('change2', 'Change…')] }),
    mark('hydro', { detail: { icon: 'NewReleases', parts: [{ text: 'New from the bank: HYDRO ONE NETWORKS' }] }, buttons: [action('accept3', 'Accept'), action('change3', 'Change…')] })
  ],
  summaries: [{ contributor: 'import.review', message: '3 imported transactions to review', actions: [action('acceptAll', 'Accept All…', { args: { accountId: 'c' } })] }]
}

const view = (over: { account?: Account, annotations?: RegisterAnnotations } = {}): RegisterView => ({
  account: over.account ?? account(),
  rows: [
    { transaction: tx('keg', '2026-10-03', -5000), balance: 95000, available: 95000, payeeName: 'The Keg' },
    { transaction: tx('salary', '2026-10-04', 300000), balance: 395000, available: 395000, payeeName: 'Employer' },
    { transaction: tx('costco', '2026-10-05', -8400), balance: 386600, available: 386600, payeeName: 'Costco' },
    { transaction: tx('hydro', '2026-10-07', -8000), balance: 378600, available: 378600, payeeName: 'Hydro One' }
  ],
  balances: { current: 378600, available: 378600, cleared: 100000, reconciled: 100000, transactionCount: 4 },
  annotations: over.annotations ?? MARKS
})

/** Chequing being reconciled, with the Keg on the statement's list. */
const reconciling = () => ({
  account: account(),
  reconciliation: {
    id: 'r', rev: 1, accountId: 'c', reconcilerId: 'accounts.reconcile.statement', paused: false, addedIds: [], startedAt: '',
    statementDate: '2026-10-31', startingBalance: 100000, statementBalance: 95000
  },
  summary: { starting: 100000, marked: 0, markedCount: 0, difference: -5000, lastReconciledBalance: 100000, adjustment: -5000 },
  candidates: [{ transaction: view().rows[0].transaction, payeeName: 'The Keg', marked: false, afterStatement: false }]
})

function setup(options: { view?: RegisterView, answers?: Record<string, (data: any) => unknown> } = {}) {
  const remote = createFakeRemote({})
  let current = options.view ?? view()
  const answers: Record<string, (data: any) => unknown> = {
    [ACCOUNTS_CHANNELS.registerAccount]: () => ({ accountId: 'c' }),
    [ACCOUNTS_CHANNELS.chart]: () => ({ ledger: { name: 'Home' }, subLedgers: [], totals: {}, accounts: [] }),
    [ACCOUNTS_CHANNELS.categories]: () => [],
    [ACCOUNTS_CHANNELS.loadRegister]: () => current,
    [ACCOUNTS_CHANNELS.reconcileState]: () => null,
    [ACCOUNTS_CHANNELS.reconcileActions]: () => [],
    [EXECUTE]: () => undefined,
    ...options.answers
  }
  remote.bridge.invoke.mockImplementation(async (channel: string, data?: any) => {
    const answer = answers[channel]
    if (!answer) throw new Error(`No answer for ${channel}`)
    return answer(data)
  })
  ;(window as any).api = remote.bridge
  render(<Register />)
  const calls = (channel: string) => remote.bridge.invoke.mock.calls.filter((c: unknown[]) => c[0] === channel).map((c: unknown[]) => c[1]) as any[]
  const executed = () => calls(EXECUTE) as { id: string, args: unknown[] }[]
  return { ...remote, calls, executed, setView: (next: RegisterView) => { current = next } }
}

const table = () => screen.findByRole('table', { name: 'Register of Chequing' })
const line = (id: string) => document.querySelector(`[data-row="${id}"]`) as HTMLElement
const secondLine = (id: string) => document.querySelector(`[data-annotation="${id}"]`) as HTMLElement | null
const focusTable = async () => {
  const container = (await table()).closest('[tabindex="0"]') as HTMLElement
  container.focus()
}

describe('marks on register rows', () => {
  it('draw a second line under a marked row, with the parts to notice emphasised, describing the row', async () => {
    setup()
    await table()
    const keg = secondLine('keg')!
    expect(keg).toHaveTextContent('Possible match: Oct 3 · THE KEG #12 · 57.50')
    expect(within(keg).getByText('57.50').tagName).toBe('STRONG')
    expect(line('keg')).toHaveAttribute('aria-describedby', keg.querySelector('[id]')!.id)
    expect(line('keg')).toHaveAttribute('data-review', 'true')
    // An unmarked row has neither
    expect(secondLine('salary')).toBeNull()
    expect(line('salary')).not.toHaveAttribute('data-review')
    expect(line('salary')).not.toHaveAttribute('aria-describedby')
  })

  it('give marked rows up to two buttons in a Review column, which run the plugin’s command for the row', async () => {
    const { executed } = setup()
    const grid = await table()
    expect(within(grid).getAllByRole('columnheader').map(h => h.textContent)).toContain('Review')
    // Wider at the least, so Payee and Category keep their room beside the Review column in a narrow window
    expect(grid.style.minWidth || getComputedStyle(grid).minWidth).toBe('79.2308em')
    // Named by their labels: a tooltip describes a button, it doesn't rename it
    expect(within(line('keg')).getAllByRole('button').map(b => b.textContent)).toEqual(['Accept', 'Change…'])
    expect(within(line('keg')).getByRole('button', { name: 'Accept' })).toHaveAccessibleDescription('Use the bank’s amount, 57.50')
    expect(within(line('salary')).queryAllByRole('button')).toEqual([])

    await userEvent.click(within(line('keg')).getByRole('button', { name: 'Change…' }))

    expect(executed()).toEqual([{ id: 'import.review.change', args: [{ lineIds: ['change'] }] }])
    expect(line('keg')).toHaveClass('Mui-selected')               // the row the button is on becomes the selection
  })

  it("list a row's buttons and its other actions in its context menu", async () => {
    const { executed } = setup()
    await table()
    await userEvent.pointer({ keys: '[MouseRight]', target: line('keg') })
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map(i => i.textContent)).toEqual(
      expect.arrayContaining(['Accept', 'Change…', 'Why this match?']))
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Why this match?' }))
    expect(executed()).toEqual([{ id: 'import.review.why', args: [{ lineIds: ['why'] }] }])
  })

  it('show a bar above the register with what the plugin says, its actions, and Next, which goes round the rows to review', async () => {
    const { executed } = setup()
    await table()
    const bar = screen.getByRole('status')
    expect(bar).toHaveTextContent('3 imported transactions to review')

    await userEvent.click(within(bar).getByRole('button', { name: 'Next' }))
    expect(line('keg')).toHaveClass('Mui-selected')
    await userEvent.click(within(bar).getByRole('button', { name: 'Next' }))
    expect(line('costco')).toHaveClass('Mui-selected')             // the unmarked salary is skipped
    await userEvent.click(within(bar).getByRole('button', { name: 'Next' }))
    await userEvent.click(within(bar).getByRole('button', { name: 'Next' }))
    expect(line('keg')).toHaveClass('Mui-selected')                // round again

    await userEvent.click(within(bar).getByRole('button', { name: 'Accept All…' }))
    expect(executed()).toEqual([{ id: 'import.review.acceptAll', args: [{ accountId: 'c' }] }])
  })

  it('count the rows to review when no plugin says anything about them, and show no bar when none need review', async () => {
    const { setView, emit } = setup({ view: view({ annotations: { rows: MARKS.rows, summaries: [] } }) })
    await table()
    expect(screen.getByRole('status')).toHaveTextContent('3 transactions to review')

    setView(view({ annotations: { rows: [mark('costco', { review: false, detail: { parts: [{ text: 'Matched' }] } })], summaries: [] } }))
    act(() => emit(ACCOUNTS_EVENTS.annotations, { accounts: ['c'] }))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(secondLine('costco')).toHaveTextContent('Matched')       // still marked, just not for review
  })

  it('show the bar when a plugin has something outstanding but no row to review, without Next', async () => {
    const { executed } = setup({
      view: view({
        annotations: {
          rows: [mark('costco', { review: false, menu: [action('changeMatch', 'Change Match…', { placement: 'menu' })] })],
          summaries: [{ contributor: 'import.review', message: '1 bank line lost its match: say where it goes.', actions: [action('resolve', 'Resolve…', { args: { lineId: 'l1' } })] }]
        }
      })
    })
    await table()
    const bar = screen.getByRole('status')
    expect(bar).toHaveTextContent('1 bank line lost its match: say where it goes.')
    expect(within(bar).queryByRole('button', { name: 'Next' })).toBeNull()
    await userEvent.click(within(bar).getByRole('button', { name: 'Resolve…' }))
    expect(executed()).toEqual([{ id: 'import.review.resolve', args: [{ lineId: 'l1' }] }])
  })

  it('go through the rows to review with F8 and Shift+F8, and run the first or second button with Ctrl+Enter', async () => {
    const { executed } = setup()
    await table()
    await userEvent.click(line('salary'))
    await focusTable()

    await userEvent.keyboard('{F8}')
    expect(line('costco')).toHaveClass('Mui-selected')
    await userEvent.keyboard('{Shift>}{F8}{/Shift}')
    expect(line('keg')).toHaveClass('Mui-selected')
    await userEvent.keyboard('{Shift>}{F8}{/Shift}')
    expect(line('hydro')).toHaveClass('Mui-selected')               // backwards goes round too

    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    await userEvent.keyboard('{Control>}{Shift>}{Enter}{/Shift}{/Control}')
    expect(executed().map(e => e.id)).toEqual(['import.review.accept3', 'import.review.change3'])
    expect(document.querySelector('[data-editing="hydro"]')).toBeNull()   // Ctrl+Enter isn't Enter: the row isn't opened for editing
  })

  it('show a failure the plugin reports, or an error, as a notice', async () => {
    let answer: () => unknown = () => ({ ok: false, error: { code: 'CONFLICT', message: 'That bank line was changed elsewhere.' } })
    setup({ answers: { [EXECUTE]: () => answer() } })
    await table()
    await userEvent.click(within(line('costco')).getByRole('button', { name: 'Accept' }))
    expect(await screen.findByText('That bank line was changed elsewhere.')).toBeInTheDocument()

    answer = () => { throw new Error('Command is disabled: import.review.accept2') }
    await userEvent.click(within(line('costco')).getByRole('button', { name: 'Accept' }))
    expect(await screen.findByText('Command is disabled: import.review.accept2')).toBeInTheDocument()
  })

  it('show on a closed account, but offer nothing to do: no Review column, buttons, actions or keys', async () => {
    const { executed } = setup({ view: view({ account: account({ closed: true }) }) })
    const grid = await table()
    expect(secondLine('keg')).toHaveTextContent('Possible match')
    expect(within(grid).getAllByRole('columnheader').map(h => h.textContent)).not.toContain('Review')
    expect(within(line('keg')).queryAllByRole('button')).toEqual([])
    const bar = screen.getByRole('status')
    expect(within(bar).getAllByRole('button').map(b => b.textContent)).toEqual(['Next'])

    await userEvent.click(line('keg'))
    await focusTable()
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    expect(executed()).toEqual([])
  })

  it('reload when a plugin says the marks on this register changed, and not for another register', async () => {
    const { calls, emit } = setup()
    await table()
    const loads = () => calls(ACCOUNTS_CHANNELS.loadRegister).length
    const before = loads()
    act(() => emit(ACCOUNTS_EVENTS.annotations, { accounts: ['someone-else'] }))
    act(() => emit(ACCOUNTS_EVENTS.annotations, { accounts: ['c'] }))
    await waitFor(() => expect(loads()).toBe(before + 1))
  })

  it('are not shown while the account is being reconciled', async () => {
    setup({ answers: { [ACCOUNTS_CHANNELS.reconcileState]: () => reconciling() } })
    await screen.findByRole('table', { name: 'Reconcile Chequing' })
    expect(screen.queryByRole('status')).toBeNull()
    expect(document.querySelector('[data-annotation]')).toBeNull()
  })
})
