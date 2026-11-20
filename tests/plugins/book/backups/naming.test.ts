// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  backupFileName, backupStamp, isBackupFileName, safeFileName
} from '../../../../plugins/book/src/privileged/backups/naming'

// Local time, as the user's file manager shows it
const at = new Date(2026, 10, 19, 18, 42, 10)

describe('backup file names', () => {
  it('are the book name and the local date and time, without colons', () => {
    expect(backupStamp(at)).toBe('2026-11-19 18.42.10')
    expect(backupStamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02 03.04.05')
    expect(backupFileName('Home Finances', at, 'auto')).toBe('Home Finances 2026-11-19 18.42.10.tessera-backup')
  })

  it('say how they were made, except for automatic ones', () => {
    expect(backupFileName('Home', at, 'manual')).toBe('Home 2026-11-19 18.42.10 (manual).tessera-backup')
    expect(backupFileName('Home', at, 'pre-restore')).toBe('Home 2026-11-19 18.42.10 (before restore).tessera-backup')
  })

  it('count up when a name is taken', () => {
    expect(backupFileName('Home', at, 'auto', 1)).toBe('Home 2026-11-19 18.42.10.tessera-backup')
    expect(backupFileName('Home', at, 'auto', 2)).toBe('Home 2026-11-19 18.42.10 (2).tessera-backup')
    expect(backupFileName('Home', at, 'manual', 3)).toBe('Home 2026-11-19 18.42.10 (manual) (3).tessera-backup')
  })

  it.each([
    ['a/b\\c', 'a_b_c'],
    ['Q1: "Taxes" <draft>?', 'Q1_ _Taxes_ _draft__'],
    ['pipes|and*stars', 'pipes_and_stars'],
    ['tab\there', 'tab_here'],
    ['ends with dots...', 'ends with dots'],
    ['  padded  ', 'padded'],
    ['', 'Book'],
    ['...', 'Book'],
    ['CON', 'CON_'],
    ['lpt1', 'lpt1_'],
    ['Résumé 🏦 finances', 'Résumé 🏦 finances']
  ])('make %j safe as %j', (name, safe) => {
    expect(safeFileName(name)).toBe(safe)
  })

  it('never contain a character any platform rejects', () => {
    const nasty = ['a<b>c', 'x:y', 'q"r', 'p|q', 'what?', 'star*', 'nul\u0000l', 'new\nline', 'back\\slash', 'for/ward']
    for (const name of nasty) expect(backupFileName(name, at, 'auto')).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/)
  })

  it('shorten a very long book name, by whole characters', () => {
    const safe = safeFileName('🏦'.repeat(150))
    expect(Array.from(safe)).toHaveLength(100)
    expect(safe).toBe('🏦'.repeat(100))
  })

  it('are recognised by extension, whatever its case, and a partial file is not one', () => {
    expect(isBackupFileName('Home 2026-11-19 18.42.10.tessera-backup')).toBe(true)
    expect(isBackupFileName('HOME.TESSERA-BACKUP')).toBe(true)
    expect(isBackupFileName('Home.tessera-backup.1a2b3c4d.partial')).toBe(false)
    expect(isBackupFileName('Home.tessera')).toBe(false)
  })
})
