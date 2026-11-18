// The import history dialog: what each import did, and whether it can still be taken back out.
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { HistoryDialogInput, HistoryEntry, ImportBatch } from '@tessera/exchange-api'
import HistoryDialog, { describe as describeBatch, when } from '../../../../plugins/exchange/src/renderer/HistoryDialog'
import { showTimestamp } from '../../../../plugins/exchange/src/renderer/display'

const batch = (over: Partial<ImportBatch> = {}): ImportBatch => ({
  id: 'b1',
  importedAt: '2026-11-18T09:00:00.000Z',
  lastAcceptedAt: '2026-11-18T09:05:00.000Z',
  closedAt: '2026-11-18T09:05:00.000Z',
  formatId: 'exchange-ofx.ofx',
  fileName: 'chequing-2026-10.ofx',
  fileHash: 'abc',
  accountIds: ['a1'],
  created: [{ accountId: 'a1', rows: [{ id: 't1', at: '2026-11-18T09:00:00.000Z' }] }],
  merged: [],
  createdAccounts: [],
  createdCategories: [],
  counts: { read: 3, imported: 1, merged: 1, duplicates: 1, skipped: 0, unsupported: 0 },
  manualMatches: 0,
  rev: 1,
  ...over
})

const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  batch: batch(), accountNames: ['Chequing'], ...over
})

function setup(entries: HistoryEntry[] = [entry()]) {
  const close = vi.fn()
  const input: HistoryDialogInput = { entries }
  render(<HistoryDialog input={input} close={close} setBusy={() => {}} />)
  return { close }
}

const undoButton = () => screen.getByRole('button', { name: 'Undo Import' })
const rows = () => within(screen.getByRole('list', { name: 'Imports' })).getAllByRole('button')

describe('the list', () => {
  it('names the file, the accounts and what the import did', () => {
    setup()
    expect(screen.getByText('chequing-2026-10.ofx')).toBeInTheDocument()
    expect(screen.getByText(/Chequing · 1 added, 1 matched, 1 already here/)).toBeInTheDocument()
  })

  it('shows every import, most recent first as it was given them', () => {
    setup([
      entry({ batch: batch({ id: 'b1', fileName: 'november.ofx' }) }),
      entry({ batch: batch({ id: 'b2', fileName: 'october.ofx' }) })
    ])
    expect(rows().map(r => r.textContent)).toEqual([
      expect.stringContaining('november.ofx'),
      expect.stringContaining('october.ofx')
    ])
  })

  it('marks an import already undone, and one still being read', () => {
    setup([
      entry({ batch: batch({ id: 'b1', undoneAt: '2026-11-19T09:00:00.000Z' }), blocked: 'Already undone' }),
      entry({ batch: batch({ id: 'b2', closedAt: undefined }) })
    ])
    expect(screen.getByText('Undone')).toBeInTheDocument()
    expect(screen.getByText('Still being read')).toBeInTheDocument()
  })
})

describe('undoing', () => {
  it('needs an import chosen first', async () => {
    setup()
    expect(undoButton()).toBeDisabled()
    expect(screen.getByText(/Choose an import to undo it/)).toBeInTheDocument()

    await userEvent.click(rows()[0])
    expect(undoButton()).toBeEnabled()
  })

  it('closes with the chosen import', async () => {
    const { close } = setup()
    await userEvent.click(rows()[0])
    await userEvent.click(undoButton())
    expect(close).toHaveBeenCalledWith({ undo: 'b1' })
  })

  it('closes with nothing when the user just looks', async () => {
    const { close } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(close).toHaveBeenCalledWith()
  })

  it('refuses an import that cannot be undone, and says why instead of failing when pressed', async () => {
    setup([entry({ blocked: 'Already undone' })])
    await userEvent.click(rows()[0])
    expect(undoButton()).toBeDisabled()
    expect(screen.getByText('Already undone')).toBeInTheDocument()
  })

  it('still offers undo for an import that is only part read, since its rows are written', async () => {
    setup([entry({ batch: batch({ closedAt: undefined }) })])
    await userEvent.click(rows()[0])
    expect(undoButton()).toBeEnabled()
  })
})

describe('when', () => {
  it('shows one day for an import read in one sitting', () => {
    const at = '2026-11-18T09:00:00.000Z'
    expect(when(entry({ batch: batch({ importedAt: at, lastAcceptedAt: at }) }))).not.toContain('–')
  })

  it('shows a span for one read over several, because undo takes all of it back', () => {
    const spread = entry({
      batch: batch({ importedAt: '2026-11-16T09:00:00.000Z', lastAcceptedAt: '2026-11-18T09:00:00.000Z' })
    })
    expect(when(spread)).toContain('–')
  })
})

describe('describe', () => {
  it('leaves out the counts that are zero', () => {
    expect(describeBatch(entry({ batch: batch({ counts: { read: 1, imported: 1, merged: 0, duplicates: 0, skipped: 0, unsupported: 0 } }) })))
      .toBe('1 added')
  })

  it('says plainly when an import wrote nothing', () => {
    expect(describeBatch(entry({ batch: batch({ counts: { read: 1, imported: 0, merged: 0, duplicates: 0, skipped: 0, unsupported: 0 } }) })))
      .toBe('nothing written')
  })
})

describe('dates of imports', () => {
  it('are the local day of the moment, in the style every other date in the exchange dialogs uses', () => {
    const at = '2026-11-18T09:00:00.000Z'
    const expected = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(at))
    expect(showTimestamp(at)).toBe(expected)
    expect(when(entry({ batch: batch({ importedAt: at, lastAcceptedAt: at }) }))).toBe(expected)
  })

  it('never take the first ten characters of a timestamp, which is the day in UTC', () => {
    // 23:30 UTC is already the next day east of Greenwich and still the same day west of it: whichever it is,
    // it must be the day the Date itself says, not the string's prefix.
    const late = '2026-11-18T23:30:00.000Z'
    const local = new Date(late)
    const expected = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
      .format(new Date(local.getFullYear(), local.getMonth(), local.getDate()))
    expect(showTimestamp(late)).toBe(expected)
  })
})
