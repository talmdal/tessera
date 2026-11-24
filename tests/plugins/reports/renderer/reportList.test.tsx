// The Reports tab (phase R3): every report offered under its group, then My Reports; the one shown selected; one that
// can't be shown greyed, saying why; clicking or Enter shows a report through the command the menu runs.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { REPORTS_CHANNELS, REPORTS_COMMANDS as C, REPORTS_EVENTS } from '@tessera/reports-api'
import ReportList from '../../../../plugins/reports/src/renderer/ReportList'
import { catalogOf, renderInTheme, reportsBridge } from './fixtures'

const list = () => screen.findByRole('listbox', { name: 'Reports for Home' })

describe('the Reports tab', () => {
  it('lists the reports under their groups, then My Reports, with the one shown selected', async () => {
    reportsBridge({
      [REPORTS_CHANNELS.catalog]: () => catalogOf({
        saved: [
          { id: 's1', name: 'Groceries this year', basis: 'Spending by Category', available: true },
          { id: 's2', name: 'Budget check', basis: 'budget.vsActual', available: false, reason: 'Needs the “budget” plugin.' }
        ]
      })
    })
    renderInTheme(<ReportList />)
    const box = await list()
    const groups = within(box).getAllByRole('group')
    expect(groups.map(g => within(g).getAllByRole('option').map(o => o.getAttribute('aria-label')))).toEqual([
      ['Income vs Expenses', 'Spending by Category', 'Spending by Payee', 'Category Trends', 'Cash Flow'],
      ['Net Worth', 'Account Balances'],
      ['Groceries this year', 'Budget check']
    ])
    expect(screen.getByText('My Reports')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Income vs Expenses' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('option', { name: 'Budget check' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('shows a report through the command, by click or by the keys; one greyed does nothing', async () => {
    const bridge = reportsBridge({
      [REPORTS_CHANNELS.catalog]: () => catalogOf({ shown: null, saved: [{ id: 's2', name: 'Budget check', basis: 'x', available: false, reason: 'Needs the “budget” plugin.' }] })
    })
    renderInTheme(<ReportList />)
    await list()
    await userEvent.click(screen.getByRole('option', { name: 'Net Worth' }))
    expect(bridge.executed()).toEqual([{ id: C.show, args: [{ definitionId: 'reports.netWorth' }] }])
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(bridge.executed()[1]).toEqual({ id: C.show, args: [{ definitionId: 'reports.accountBalances' }] })
    await userEvent.click(screen.getByRole('option', { name: 'Budget check' }))
    expect(bridge.executed()).toHaveLength(2)
  })

  it('renames, duplicates and deletes a saved report from its context menu, or by F2 and Delete (R4)', async () => {
    const bridge = reportsBridge({
      [REPORTS_CHANNELS.catalog]: () => catalogOf({ saved: [{ id: 's1', name: 'Mine', basis: 'Net Worth', available: true }] })
    })
    renderInTheme(<ReportList />)
    await list()
    fireEvent.contextMenu(screen.getByRole('option', { name: 'Mine' }))
    expect((await screen.findAllByRole('menuitem')).map(m => m.textContent)).toEqual(['Show Report', 'Rename…F2', 'Duplicate…', 'Delete…Delete'])
    await userEvent.click(screen.getByRole('menuitem', { name: /Duplicate/ }))
    expect(bridge.executed()).toEqual([{ id: C.duplicate, args: [{ id: 's1' }] }])
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    act(() => screen.getByRole('option', { name: 'Mine' }).focus())
    await userEvent.keyboard('{F2}')
    await userEvent.keyboard('{Delete}')
    expect(bridge.executed().slice(1)).toEqual([{ id: C.rename, args: [{ id: 's1' }] }, { id: C.deleteSaved, args: [{ id: 's1' }] }])
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    // A report offered has no such menu
    fireEvent.contextMenu(screen.getByRole('option', { name: 'Net Worth' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('offers nothing that writes in a ledger open read-only (R4)', async () => {
    const bridge = reportsBridge({
      [REPORTS_CHANNELS.catalog]: () => catalogOf({ readOnly: true, saved: [{ id: 's1', name: 'Mine', basis: 'Net Worth', available: true }] })
    })
    renderInTheme(<ReportList />)
    await list()
    fireEvent.contextMenu(screen.getByRole('option', { name: 'Mine' }))
    await screen.findAllByRole('menuitem')
    for (const name of [/Rename/, /Duplicate/, /Delete/]) expect(screen.getByRole('menuitem', { name })).toHaveAttribute('aria-disabled', 'true')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    act(() => screen.getByRole('option', { name: 'Mine' }).focus())
    await userEvent.keyboard('{F2}{Delete}')
    expect(bridge.executed()).toEqual([])
  })

  it('follows the catalog: another report shown, or a ledger closed', async () => {
    const bridge = reportsBridge()
    const { container } = renderInTheme(<ReportList />)
    await list()
    act(() => bridge.emit(REPORTS_EVENTS.catalog, catalogOf({ shown: { ref: { definitionId: 'reports.cashFlow' }, request: 2 } })))
    await waitFor(() => expect(screen.getByRole('option', { name: 'Cash Flow' })).toHaveAttribute('aria-selected', 'true'))
    act(() => bridge.emit(REPORTS_EVENTS.catalog, null))
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })
})
