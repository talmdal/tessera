// `npm run archive:book`: writes an archive of a book file with the real ArchiveWriter, and leaves the book alone.
//
// This is the headless path for phase 1 of docs/archive-design.md: the copy, not the prune. Nothing is removed from
// the book, here or ever by this script — use it to look at what an archive of a real book comes out like, and to
// check it opens.
import fs from 'node:fs'
import path from 'node:path'
import { BOOK_META, DEFAULT_ARCHIVE_FOLDER_NAME, type ArchiveSuggestion, type BookInfo } from '@tessera/book-api'
import { nodeDisk } from '../../plugins/book/src/privileged/disk'
import { nodeBackupDisk } from '../../plugins/book/src/privileged/backups/BackupDisk'
import { ArchiveWriter } from '../../plugins/book/src/privileged/archive/ArchiveWriter'
import { isIsoDate, suggestedCutoff } from '../../plugins/book/src/privileged/archive/naming'
import { scopedTransaction } from '../../plugins/book/src/privileged/scopedDatabase'
import { collectionsOf } from '../../plugins/accounts/src/privileged/store'
import { planAccountsArchive } from '../../plugins/accounts/src/privileged/archiveCore'
import { accountsArchiveParticipant } from '../../plugins/accounts/src/privileged/archiveParticipant'
import { ENGINES, documentCount, inflate } from '../bench/bench'

interface Options {
  book: string
  before: string
  folder?: string
  engine: string
  /** Repeat the book's transactions this many times (in a temporary copy) before timing. */
  factor: number
  /** Also prune a temporary copy of the book, timing it. The original is never pruned. */
  prune: boolean
}

function usage() {
  console.log(`Writes an archive of a book: a complete, frozen, read-only copy. The book itself is not changed.

  npm run archive:book -- --book path.tessera                  archive before 1 January of this year
  npm run archive:book -- --book path.tessera --before 2025-01-01
  npm run archive:book -- --book path.tessera --folder ~/Archives
  npm run archive:book -- --book path.tessera --engine loki    the engine the book was written with (default sqlite)
  npm run archive:book -- --book path.tessera --prune          also time pruning — a COPY is pruned, never the book
  npm run archive:book -- --book path.tessera --prune --factor 200   ...with the transactions repeated 200 times

The archive is named "<Book> Archive through <date>.tessera" and opens with File > Open, read-only.`)
}

export function parseArgs(argv: string[], today = new Date()): Options | undefined {
  const options: Partial<Options> = { before: suggestedCutoff('startOfThisYear' as ArchiveSuggestion, today), engine: 'sqlite', factor: 1, prune: false }
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at]
    const value = () => argv[++at]
    if (arg === '--book') {
      const book = value()
      if (!book) throw new Error('--book needs a path')
      options.book = path.resolve(book)
    }
    else if (arg === '--before') {
      const before = value()
      if (!isIsoDate(before)) throw new Error(`--before needs a date as YYYY-MM-DD, not "${before ?? ''}"`)
      options.before = before
    }
    else if (arg === '--folder') {
      const folder = value()
      if (!folder) throw new Error('--folder needs a path')
      options.folder = path.resolve(folder)
    }
    else if (arg === '--engine') {
      const engine = value() ?? ''
      if (!ENGINES[engine]) throw new Error(`Unknown engine "${engine}": use ${Object.keys(ENGINES).join(' or ')}`)
      options.engine = engine
    }
    else if (arg === '--prune') options.prune = true
    else if (arg === '--factor') {
      const factor = Number(value())
      if (!Number.isInteger(factor) || factor < 1) throw new Error('--factor must be a whole number of at least 1')
      options.factor = factor
    }
    else if (arg === '--help' || arg === '-h') { usage(); return undefined }
    else throw new Error(`Unknown option "${arg}". Try --help.`)
  }
  if (!options.book) throw new Error('--book is required. Try --help.')
  return options as Options
}

export async function main(argv: string[]) {
  const options = parseArgs(argv)
  if (!options) return
  if (!fs.existsSync(options.book)) throw new Error(`There is no book at ${options.book}`)

  const folder = options.folder ?? path.join(path.dirname(options.book), DEFAULT_ARCHIVE_FOLDER_NAME)
  const engine = ENGINES[options.engine](path.dirname(options.book))
  const db = await engine.open({ path: options.book })
  const before = await db.snapshot()

  const book: BookInfo = {
    id: (before.meta[BOOK_META.id] as string) ?? 'unknown',
    path: options.book,
    name: path.basename(options.book, '.tessera'),
    readOnly: false
  }

  const writer = new ArchiveWriter({
    engine,
    bookDisk: nodeDisk(),
    folders: nodeBackupDisk(),
    // The session's probe is not here; the writer's own verification reads the whole file back
    probe: async () => {},
    log: { info: message => console.log(message), warn: message => console.warn(message), error: message => console.error(message) }
  })

  // With a factor, time against an inflated temporary copy; the user's own file is only ever read
  let timed = db
  let timedPath = options.book
  if (options.factor > 1) {
    const grown = inflate(before, options.factor, 1)
    timedPath = path.join(folder, `.archive-bench-${Date.now()}.tessera`)
    await (await engine.open({ path: timedPath })).load(grown)
    timed = await engine.open({ path: timedPath })
    console.log(`Timing against a copy with the transactions repeated ${options.factor}×: ${documentCount(grown)} documents`)
  }
  const timedBook: BookInfo = { ...book, path: timedPath, readOnly: false }

  const planStart = Date.now()
  const plan = await planAccountsArchive(collectionsOf(timed), { before: options.before, removeReconciled: true, removeVoided: true })
  const planMs = Date.now() - planStart

  const started = Date.now()
  const outcome = await writer.write(timed, timedBook, { before: options.before, folder, createFolder: true })
  const writeMs = Date.now() - started

  let pruneMs: number | undefined
  if (options.prune) {
    // Prune the copy (or, with no factor, a staged copy of the book) — never the book the user named
    let target = timed
    let targetPath = timedPath
    if (options.factor <= 1) {
      targetPath = path.join(folder, `.archive-bench-${Date.now()}.tessera`)
      await (await engine.open({ path: targetPath })).load(before)
      target = await engine.open({ path: targetPath })
    }
    const participant = accountsArchiveParticipant({ collections: () => collectionsOf(target) })
    const survey = await participant.survey({ before: options.before, removeReconciled: true, removeVoided: true }, new Set())
    const pruneStart = Date.now()
    await target.transaction(tx => participant.prune(scopedTransaction(tx, 'accounts'), {
      request: { before: options.before, removeReconciled: true, removeVoided: true },
      removedIds: new Set(survey.removesIds)
    }))
    pruneMs = Date.now() - pruneStart
    await target.flush()
    if (targetPath !== timedPath) { await target.close(); fs.rmSync(targetPath, { force: true }); fs.rmSync(`${targetPath}-wal`, { force: true }); fs.rmSync(`${targetPath}-shm`, { force: true }) }
  }

  const after = await db.snapshot()
  await engine.closeAll()
  if (timedPath !== options.book) { fs.rmSync(timedPath, { force: true }); fs.rmSync(`${timedPath}-wal`, { force: true }); fs.rmSync(`${timedPath}-shm`, { force: true }) }

  const unchanged = JSON.stringify(after) === JSON.stringify(before)
  console.log(`Archived “${book.name}” through ${options.before}`)
  console.log(`  ${outcome.file}`)
  console.log(`  ${outcome.documents} documents in ${outcome.collections} collections, ${fs.statSync(outcome.file).size} bytes`)
  console.log(`  plan ${planMs} ms · write+verify ${writeMs} ms${pruneMs !== undefined ? ` · prune ${pruneMs} ms (${plan.transactionIds.length} transactions)` : ''}`)
  console.log(`  the book itself: ${unchanged ? 'unchanged' : 'CHANGED — that is a bug'}`)
  if (!unchanged) process.exitCode = 1
}
