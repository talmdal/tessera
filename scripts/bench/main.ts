// `npm run bench:backup`: times backup and restore on a seeded book at several sizes, on each storage engine, and
// says whether quitting fits the shutdown budget. Run it on the machine you care about: the figures are its own.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { KitStorageEngine } from '@tessera/storage-kit'
import { sqliteDriver } from '../../plugins/storage.sqlite/src/privileged/SqliteDriver'
import { BACKUP_SHUTDOWN_BUDGET_MS } from '../../plugins/book/src/privileged/backups/Backups'
import { main as seedBook } from '../seed/main'
import { ENGINES, documentCount, formatTable, inflate, measure, verdict, type Row } from './bench'

interface Options {
  book?: string
  factors: number[]
  engines: string[]
  runs: number
  seed: number
}

function usage() {
  console.log(`Times backup and restore with the real code, and checks quitting fits the shutdown budget.

  npm run bench:backup                              a freshly seeded Household book, at 1×, 10×, 50×, 100× and 200×
  npm run bench:backup -- --book path.tessera       a SQLite book of your own instead
  npm run bench:backup -- --factors 1,100           other sizes: how many times the transactions are repeated
  npm run bench:backup -- --engines sqlite          one engine (sqlite, loki; default both)
  npm run bench:backup -- --runs 5                  the median of more runs (default 3)
  npm run bench:backup -- --seed 7                  other varied data in the scaled copies (default 1)

Prints a Markdown table (times in milliseconds) and exits with 1 if a quit path exceeds the budget.`)
}

const list = (value: string | undefined, what: string) => {
  if (!value) throw new Error(`${what} needs a value`)
  return value.split(',').map(v => v.trim()).filter(Boolean)
}

const whole = (value: string, what: string) => {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${what} must be a whole number of at least 1, not "${value}"`)
  return n
}

export function parseArgs(argv: string[]): Options | undefined {
  const options: Options = { factors: [1, 10, 50, 100, 200], engines: Object.keys(ENGINES), runs: 3, seed: 1 }
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at]
    const value = () => argv[++at]
    if (arg === '--book') {
      const book = value()
      if (!book) throw new Error('--book needs a path')
      options.book = path.resolve(book)
    }
    else if (arg === '--factors') options.factors = list(value(), '--factors').map(f => whole(f, '--factors'))
    else if (arg === '--engines') options.engines = list(value(), '--engines')
    else if (arg === '--runs') options.runs = whole(value() ?? '', '--runs')
    else if (arg === '--seed') options.seed = whole(value() ?? '', '--seed')
    else if (arg === '--help' || arg === '-h') { usage(); return undefined }
    else throw new Error(`Unknown option "${arg}". Try --help.`)
  }
  for (const engine of options.engines) if (!ENGINES[engine]) throw new Error(`Unknown engine "${engine}": use ${Object.keys(ENGINES).join(' or ')}`)
  return options
}

export async function main(argv: string[]) {
  const options = parseArgs(argv)
  if (!options) return
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tessera-bench-'))
  try {
    let book = options.book
    if (!book) {
      book = path.join(work, 'Household.tessera')
      await seedBook(['--book', book, '--fixtures', path.join(work, 'fixtures'), '--quiet'])
    }
    const reader = new KitStorageEngine(sqliteDriver({ directory: path.join(work, 'storage') }))
    const base = await (await reader.open({ path: book }, { readOnly: true })).snapshot()
    await reader.closeAll()

    const cpu = os.cpus()[0]?.model.trim() ?? 'an unknown processor'
    console.log(`Book: ${path.basename(book)}, ${documentCount(base).toLocaleString('en-US')} documents. ` +
      `Machine: ${cpu}, ${os.cpus().length} threads, ${os.platform()} ${os.release()}, Node ${process.version}. ` +
      `Median of ${options.runs} run${options.runs === 1 ? '' : 's'}; times in ms.\n`)

    const rows: Row[] = []
    for (const factor of options.factors) {
      const snapshot = inflate(base, factor, options.seed)
      for (const engine of options.engines) {
        process.stderr.write(`  ${engine} ×${factor} (${documentCount(snapshot).toLocaleString('en-US')} documents)…\n`)
        rows.push(await measure(engine, snapshot, factor, work, options.runs))
      }
    }
    console.log(formatTable(rows))
    const { fits, text } = verdict(rows, BACKUP_SHUTDOWN_BUDGET_MS)
    console.log(`\n${text}`)
    if (!fits) process.exitCode = 1
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true })
  }
}
