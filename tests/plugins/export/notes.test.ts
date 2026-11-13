// What the Export dialog and the message say about accounts an archive file takes over from: one sentence for them all.
import { describe, expect, it } from 'vitest'
import { archivedNote, joinList, listNames } from '../../../plugins/export/src/shared/notes'

describe('export notes', () => {
  it('joins a list as a sentence does', () => {
    expect(joinList([])).toBe('')
    expect(joinList(['a'])).toBe('a')
    expect(joinList(['a', 'b'])).toBe('a and b')
    expect(listNames(['A', 'B', 'C'])).toBe('“A”, “B” and “C”')
  })

  it('says once which accounts an archive file takes over from', () => {
    expect(archivedNote([])).toBeUndefined()
    expect(archivedNote([{ account: 'Visa', from: '2026-11-01' }])).toBe('“Visa” starts on Nov 1, 2026: its earlier transactions are in an archive file.')
    expect(archivedNote(['Visa', 'Chequing', 'Savings'].map(account => ({ account, from: '2026-11-01' }))))
      .toBe('“Visa”, “Chequing” and “Savings” start on Nov 1, 2026: their earlier transactions are in an archive file.')
    expect(archivedNote([{ account: 'Visa', from: '2026-11-01' }, { account: 'Chequing', from: '2026-10-02' }]))
      .toBe('Earlier transactions are in an archive file for “Visa” (from Nov 1, 2026) and “Chequing” (from Oct 2, 2026).')
  })
})
