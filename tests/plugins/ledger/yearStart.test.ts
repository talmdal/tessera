// @vitest-environment node
// The ledger's year start (ledger-api 1.5): kept in the ledger's meta, given to a new ledger or an older one from the
// Archiving page's old setting, set with `setYearStart` or File › Ledger Properties…, and used by Archive Ledger….
// See docs/reporting-design.md, "The ledger's year start".
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_YEAR_START, LEDGER_ARCHIVES_FOLDER, LEDGER_BACKUP_META, LEDGER_CHANNELS, LEDGER_COMMANDS, LEDGER_DIALOGS, LEDGER_EVENTS,
  LEDGER_META, YEAR_START_MONTH_DAYS, yearStartLabel, yearStartOf, yearStartProblem,
  type ArchiveDialogInput, type LedgerChange, type LedgerInfo
} from '@tessera/ledger-api'
import { DIR, file, setupSession } from './harness'
import { activateLedger, type LedgerPlugin } from './plugin'

/** Noon on 10 November 2026, local time. */
const NOW = new Date(2026, 10, 10, 12)
const ARCHIVE = path.join(DIR, 'Documents', 'Tessera Backups', LEDGER_ARCHIVES_FOLDER, 'Old (archive before 2026-01-01).tesserabkp')
/** The Archiving page's settings as a user who archived at the end of a UK tax year left them. */
const UK_ARCHIVING = { 'ledger.archive': { yearStartMonth: 4, yearStartDay: 6, keepYears: 0 } }

/** A ledger file an earlier version left: marked as a ledger, with an id, and no year start. */
function olderLedger(env: LedgerPlugin, at: string, extra: [string, unknown][] = []) {
  env.driver.databases.set(at, {
    collections: new Map(),
    meta: new Map<string, never>([[LEDGER_META.format, 1 as never], [LEDGER_META.id, 'OLD' as never], ...extra as [string, never][]])
  })
}

/**
 * An archive file of the open ledger, as File › Archive Ledger… makes it: a snapshot with the archive's meta. (Archiving
 * itself needs a participant with something to remove; archiveCommand.test.ts tests that.)
 */
async function archiveOf(env: LedgerPlugin, ledger: LedgerInfo) {
  const db = await env.engine.open({ path: ledger.path })
  await db.snapshot({ path: ARCHIVE }, {
    meta: {
      [LEDGER_BACKUP_META.takenAt]: '2026-11-10T17:00:00.000Z', [LEDGER_BACKUP_META.kind]: 'archive', [LEDGER_BACKUP_META.ledgerName]: ledger.name,
      [LEDGER_BACKUP_META.ledgerPath]: ledger.path, [LEDGER_BACKUP_META.takenWith]: 'ledger test', [LEDGER_BACKUP_META.archiveBefore]: '2026-01-01'
    }
  })
  return ARCHIVE
}

/** The year start in a file's meta, as written. */
const storedIn = (env: LedgerPlugin, at: string) => env.driver.databases.get(at)!.meta.get(LEDGER_META.yearStart)

/** The problem `setYearStart` refuses with, as `code field: message`. */
const refusal = async (work: Promise<unknown>) => {
  try { await work } catch (err) {
    const { code, field, message } = err as { code: string, field?: string, message: string }
    return `${code}${field ? ` ${field}` : ''}: ${message}`
  }
  return 'accepted'
}

describe('the rules for a year start', () => {
  it('take a month and a day that is there every year: February stops at 28', () => {
    expect(yearStartProblem({ month: 1, day: 1 })).toBeUndefined()
    expect(yearStartProblem({ month: 4, day: 6 })).toBeUndefined()
    expect(yearStartProblem({ month: 2, day: 28 })).toBeUndefined()
    expect(yearStartProblem({ month: 12, day: 31 })).toBeUndefined()
    expect(yearStartProblem({ month: 2, day: 29 })).toBe('A year can’t start on 29 February: it isn’t there every year.')
    expect(yearStartProblem({ month: 4, day: 31 })).toBe('Choose a day from 1 to 30.')
    expect(yearStartProblem({ month: 1, day: 0 })).toBe('Choose a day from 1 to 31.')
    expect(yearStartProblem({ month: 1, day: 1.5 })).toBe('Choose a day from 1 to 31.')
    expect(yearStartProblem({ month: 13, day: 1 })).toBe('Choose the month the year starts, 1 to 12.')
    expect(yearStartProblem({ month: '4', day: 6 })).toBe('Choose the month the year starts, 1 to 12.')
    expect(yearStartProblem(null)).toBe('Choose the month and day the year starts.')
    expect(yearStartProblem('6 April')).toBe('Choose the month and day the year starts.')
    expect(YEAR_START_MONTH_DAYS).toHaveLength(12)
  })

  it('read a ledger without one (a LedgerInfo made by hand) as a calendar year, and label it as people read it', () => {
    expect(yearStartOf(undefined)).toEqual(DEFAULT_YEAR_START)
    expect(yearStartOf({})).toEqual({ month: 1, day: 1 })
    expect(yearStartOf({ yearStart: { month: 2, day: 29 } })).toEqual({ month: 1, day: 1 })
    expect(yearStartOf({ yearStart: { month: 4, day: 6 } })).toEqual({ month: 4, day: 6 })
    // The label is the user's locale's; whatever it is, it names the day and the month, not a year
    expect(yearStartLabel({ month: 4, day: 6 })).toMatch(/6/)
    expect(yearStartLabel({ month: 4, day: 6 })).not.toMatch(/2001/)
    expect(yearStartLabel({ month: 4, day: 6 })).toBe(new Date(Date.UTC(2001, 3, 6)).toLocaleDateString([], { day: 'numeric', month: 'long', timeZone: 'UTC' }))
  })
})

describe('a ledger\'s year start', () => {
  it('is a calendar year for a new ledger, written into it', async () => {
    const env = await activateLedger({ now: () => NOW })
    const home = await env.newLedger('Home.tessera')
    expect(home.yearStart).toEqual({ month: 1, day: 1 })
    expect(storedIn(env, home.path)).toEqual({ month: 1, day: 1 })
  })

  it('is the Archiving page\'s year start for a new ledger, when the user had set one there', async () => {
    const env = await activateLedger({ now: () => NOW, settings: UK_ARCHIVING })
    const home = await env.newLedger('Home.tessera')
    expect(home.yearStart).toEqual({ month: 4, day: 6 })
    expect(storedIn(env, home.path)).toEqual({ month: 4, day: 6 })
  })

  it('is given to an older ledger from the Archiving page on its first writable open, so upgrading changes nothing', async () => {
    const env = await activateLedger({ now: () => NOW, settings: UK_ARCHIVING })
    olderLedger(env, file('Old.tessera'))
    expect((await env.session.open(file('Old.tessera')))?.yearStart).toEqual({ month: 4, day: 6 })
    expect(storedIn(env, file('Old.tessera'))).toEqual({ month: 4, day: 6 })

    // The ledger's own from then on: the page's old value changing later doesn't move it
    env.runtime.settings.commit([{ id: 'ledger.archive', value: { yearStartMonth: 7, yearStartDay: 1, keepYears: 0 } }])
    await env.session.close()
    expect((await env.session.open(file('Old.tessera')))?.yearStart).toEqual({ month: 4, day: 6 })
    expect(env.log.warn).not.toHaveBeenCalled()
  })

  it('reads a damaged value as the default, and writes the default over it, saying so', async () => {
    const env = await activateLedger({ now: () => NOW })
    olderLedger(env, file('Odd.tessera'), [[LEDGER_META.yearStart, { month: 2, day: 29 }]])
    expect((await env.session.open(file('Odd.tessera')))?.yearStart).toEqual({ month: 1, day: 1 })
    expect(storedIn(env, file('Odd.tessera'))).toEqual({ month: 1, day: 1 })
    expect(env.log.warn).toHaveBeenCalledWith(expect.stringContaining('has a year start that can\'t be used'))
  })

  it('is shown for an archive file without one, and nothing is written to the file', async () => {
    const env = await activateLedger({ now: () => NOW, settings: UK_ARCHIVING })
    olderLedger(env, ARCHIVE, [
      [LEDGER_BACKUP_META.takenAt, '2026-01-02T10:00:00.000Z'], [LEDGER_BACKUP_META.kind, 'archive'],
      [LEDGER_BACKUP_META.ledgerName, 'Old'], [LEDGER_BACKUP_META.archiveBefore, '2026-01-01']
    ])
    const before = JSON.stringify([...env.driver.databases.get(ARCHIVE)!.meta])

    const opened = await env.session.open(ARCHIVE)

    expect(opened).toMatchObject({ readOnly: true, yearStart: { month: 4, day: 6 } })
    expect(JSON.stringify([...env.driver.databases.get(ARCHIVE)!.meta])).toBe(before)
    expect(env.log.warn).not.toHaveBeenCalled()      // not even tried
    expect(await refusal(env.session.setYearStart({ month: 1, day: 1 }))).toBe('READ_ONLY: An archive file can’t be changed.')
  })

  it('goes into backups and archive files with the rest of the meta, so they keep the year they were made with', async () => {
    const env = await activateLedger({ now: () => NOW })
    const home = await env.newLedger('Home.tessera')
    await env.session.setYearStart({ month: 7, day: 1 })
    const backup = await env.run<string>(LEDGER_COMMANDS.backup, { path: file('Copy') })
    expect(storedIn(env, backup)).toEqual({ month: 7, day: 1 })

    const archive = await archiveOf(env, home)
    await env.session.setYearStart({ month: 1, day: 1 })
    expect((await env.session.open(archive))?.yearStart).toEqual({ month: 7, day: 1 })
  })
})

describe('setYearStart', () => {
  it('sets the year start in the meta, and says so with onDidChangeInfo, not onDidChange', async () => {
    const env = await activateLedger({ now: () => NOW })
    await env.newLedger('Home.tessera')
    const infos: LedgerInfo[] = []
    const changes: LedgerChange[] = []
    env.session.onDidChangeInfo(info => infos.push(info))
    env.session.onDidChange(change => changes.push(change))

    const ledger = await env.session.setYearStart({ month: 4, day: 6, extra: 'dropped' } as never)

    expect(ledger).toMatchObject({ name: 'Home', yearStart: { month: 4, day: 6 } })
    expect(ledger.yearStart).toEqual({ month: 4, day: 6 })
    expect(env.session.current?.yearStart).toEqual({ month: 4, day: 6 })
    expect(storedIn(env, file('Home.tessera'))).toEqual({ month: 4, day: 6 })
    expect(infos).toEqual([ledger])
    expect(changes).toEqual([])
    // The views follow the state, which carries the ledger's information
    expect(env.events.filter(e => e.name === LEDGER_EVENTS.state).at(-1)?.data).toMatchObject({ ledger: { yearStart: { month: 4, day: 6 } } })

    // The same again writes nothing and says nothing
    await env.session.setYearStart({ month: 4, day: 6 })
    expect(infos).toHaveLength(1)
  })

  it('hands out copies: changing what it returned changes nothing', async () => {
    const env = await activateLedger({ now: () => NOW })
    await env.newLedger('Home.tessera')
    const ledger = await env.session.setYearStart({ month: 4, day: 6 })
    ledger.yearStart!.month = 9
    env.session.current!.yearStart!.day = 9
    expect(env.session.current?.yearStart).toEqual({ month: 4, day: 6 })
  })

  it('refuses a day that isn\'t there every year, anything that isn\'t a year start, and no ledger', async () => {
    const env = await activateLedger({ now: () => NOW })
    expect(await refusal(env.session.setYearStart({ month: 4, day: 6 }))).toBe('NO_LEDGER: No ledger is open.')
    await env.newLedger('Home.tessera')
    expect(await refusal(env.session.setYearStart({ month: 2, day: 29 }))).toBe('INVALID yearStart: A year can’t start on 29 February: it isn’t there every year.')
    expect(await refusal(env.session.setYearStart({ month: 6, day: 31 }))).toBe('INVALID yearStart: Choose a day from 1 to 30.')
    expect(await refusal(env.session.setYearStart({ month: 0, day: 1 }))).toBe('INVALID yearStart: Choose the month the year starts, 1 to 12.')
    expect(await refusal(env.session.setYearStart(undefined as never))).toBe('INVALID yearStart: Choose the month and day the year starts.')
    expect(env.session.current?.yearStart).toEqual({ month: 1, day: 1 })
    expect(storedIn(env, file('Home.tessera'))).toEqual({ month: 1, day: 1 })
  })

  it('counts as a change for the next backup, which meta writes otherwise don\'t', async () => {
    const { session, created } = setupSession({ now: () => NOW })
    await created()
    session.backupStarting()
    expect(session.changedSinceBackup).toBe(false)
    const count = session.changeCount
    await session.setYearStart({ month: 4, day: 6 })
    expect(session.changedSinceBackup).toBe(true)
    // An archive whose copy began before it is refused: the copy has the old year start
    expect(session.changeCount).toBe(count + 1)
  })

  it('is the properties dialog\'s channel, as a Result', async () => {
    const env = await activateLedger({ now: () => NOW })
    await env.newLedger('Home.tessera')
    expect(await env.ask(LEDGER_CHANNELS.setYearStart, { yearStart: { month: 7, day: 1 } }))
      .toEqual({ ok: true, value: expect.objectContaining({ name: 'Home', yearStart: { month: 7, day: 1 } }) })
    expect(await env.ask(LEDGER_CHANNELS.setYearStart, { yearStart: { month: 2, day: 29 } }))
      .toEqual({ ok: false, error: { code: 'INVALID', field: 'yearStart', message: 'A year can’t start on 29 February: it isn’t there every year.' } })
    expect(await env.ask(LEDGER_CHANNELS.setYearStart, {}))
      .toEqual({ ok: false, error: { code: 'INVALID', field: 'yearStart', message: 'Choose the month and day the year starts.' } })
    expect(env.session.current?.yearStart).toEqual({ month: 7, day: 1 })
  })
})

describe('File › Ledger Properties…', () => {
  it('shows the open ledger\'s name, file and year start, and is disabled with none open', async () => {
    const env = await activateLedger({ now: () => NOW })
    expect(env.enabled(LEDGER_COMMANDS.properties)).toBe(false)
    const home = await env.newLedger('Home.tessera')
    await env.session.setYearStart({ month: 4, day: 6 })
    expect(env.enabled(LEDGER_COMMANDS.properties)).toBe(true)

    env.prompts.show.mockResolvedValueOnce(undefined)
    expect(await env.run(LEDGER_COMMANDS.properties)).toBeUndefined()

    expect(env.prompts.show).toHaveBeenLastCalledWith(LEDGER_DIALOGS.properties, {
      name: 'Home', path: home.path, yearStart: { month: 4, day: 6 }, readOnly: false
    })
  })

  it('shows an archive file read-only, saying what it is', async () => {
    const env = await activateLedger({ now: () => NOW })
    await env.session.open(await archiveOf(env, await env.newLedger('Home.tessera')))
    expect(env.enabled(LEDGER_COMMANDS.properties)).toBe(true)

    await env.run(LEDGER_COMMANDS.properties)

    expect(env.prompts.show).toHaveBeenLastCalledWith(LEDGER_DIALOGS.properties, expect.objectContaining({
      readOnly: true, yearStart: { month: 1, day: 1 }, archive: expect.objectContaining({ before: '2026-01-01', ledgerName: 'Home' })
    }))
  })
})

describe('File › Archive Ledger…', () => {
  it('suggests the start of the ledger\'s year, back by the Archiving page\'s years to keep', async () => {
    const env = await activateLedger({ now: () => NOW, settings: { 'ledger.archive': { yearStartMonth: 1, yearStartDay: 1, keepYears: 1 } } })
    await env.newLedger('Home.tessera')
    await env.session.setYearStart({ month: 7, day: 1 })
    const suggested = async () => {
      let input: ArchiveDialogInput | undefined
      env.prompts.show.mockImplementationOnce(async (_id: unknown, given: unknown) => { input = given as ArchiveDialogInput; return undefined })
      await env.run(LEDGER_COMMANDS.archive)
      return input?.suggestedBefore
    }

    // 10 November 2026: the year began on 1 July 2026, and one year is kept
    expect(await suggested()).toBe('2025-07-01')
    await env.session.setYearStart({ month: 12, day: 25 })
    expect(await suggested()).toBe('2024-12-25')
  })
})
