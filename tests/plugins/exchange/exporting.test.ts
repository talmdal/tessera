// @vitest-environment node
// File ▸ Export Transactions…: the order the two dialogs come in, what the save dialog is pre-filled with, and
// that cancelling either one writes nothing at all.
import { describe, expect, it, vi } from 'vitest'
import type { ExportDialogResult } from '@tessera/exchange-api'
import { suggestedPath } from '../../../plugins/exchange/src/privileged/commands'

describe('suggestedPath', () => {
  const deps = {
    files: { documentsPath: () => '/home/ada/Documents', showSaveDialog: vi.fn() },
    session: { current: { name: 'Household' } } as never
  }
  const accounts = [{ id: 'a1', name: 'Chequing' }, { id: 'a2', name: 'RRSP: Mine' }]
  const settled = (over: Partial<ExportDialogResult> = {}): ExportDialogResult => ({
    scope: { kind: 'account', accountId: 'a1' }, formatId: 'exchange-qif.qif', ...over
  })

  it('names the file after the account and the format', () => {
    expect(suggestedPath(deps, settled(), accounts, 'qif')).toBe('/home/ada/Documents/Chequing.qif')
  })

  it('adds the year when the range is one whole year, which is what makes a name worth keeping', () => {
    const request = settled({ range: { from: '2026-01-01', to: '2026-12-31' } })
    expect(suggestedPath(deps, request, accounts, 'qif')).toBe('/home/ada/Documents/Chequing 2026.qif')
  })

  it('leaves the year out when the range straddles two', () => {
    const request = settled({ range: { from: '2025-06-01', to: '2026-05-31' } })
    expect(suggestedPath(deps, request, accounts, 'csv')).toBe('/home/ada/Documents/Chequing.csv')
  })

  it('names the book when the scope is wider than one account', () => {
    expect(suggestedPath(deps, settled({ scope: { kind: 'book' } }), accounts, 'qif'))
      .toBe('/home/ada/Documents/Household.qif')
    expect(suggestedPath(deps, settled({ scope: { kind: 'subBook', subBookId: 's1', includeDescendants: true } }), accounts, 'qif'))
      .toBe('/home/ada/Documents/Household.qif')
  })

  it('strips what a file name cannot hold, because an account may be called “RRSP: Mine”', () => {
    const request = settled({ scope: { kind: 'account', accountId: 'a2' } })
    expect(suggestedPath(deps, request, accounts, 'qif')).toBe('/home/ada/Documents/RRSP- Mine.qif')
  })

  it('falls back to a usable name when the account has gone', () => {
    const request = settled({ scope: { kind: 'account', accountId: 'gone' } })
    expect(suggestedPath(deps, request, accounts, 'qif')).toBe('/home/ada/Documents/Transactions.qif')
  })
})

