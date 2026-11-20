// What `npm run bench:backup` measures: a book taken through what backup and restore do, with the real code, at
// several sizes, on each storage engine. See docs/backup-restore-design.md, "Phase 6 results".
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { KitStorageEngine } from '@tessera/storage-kit'
import type { DatabaseSnapshot, StorageEngine } from '@tessera/types'
import { sqliteDriver } from '../../plugins/storage.sqlite/src/privileged/SqliteDriver'
import { lokiDriver } from '../../plugins/storage.loki/src/privileged/LokiDriver'
import { backupHeader, readBackup, verifyBackup, writeBackup } from '../../plugins/book/src/privileged/backups/backupFile'
import { nodeBackupDisk } from '../../plugins/book/src/privileged/backups/BackupDisk'
import { backupFileName } from '../../plugins/book/src/privileged/backups/naming'
import { random } from '../seed/random'

/** The collection that grows with a book's age, and so the one scaled up. */
export const GROWING = 'accounts.transactions'

export const ENGINES: Record<string, (directory: string) => StorageEngine> = {
  sqlite: directory => new KitStorageEngine(sqliteDriver({ directory })),
  loki: directory => new KitStorageEngine(lokiDriver({ directory, saveDelay: 50 }))
}

/** One engine at one size: each time the median of the runs, in milliseconds. */
export interface Row {
  engine: string
  factor: number
  documents: number
  bookBytes: number
  backupBytes: number
  open: number
  snapshot: number
  write: number
  /** Snapshot plus write: what quitting waits for, and must fit the shutdown budget. */
  quit: number
  verify: number
  restore: number
}

/**
 * A book with its transactions repeated `factor` times. Each copy gets a fresh id and, where the row has one, a
 * fresh external id (the unique index is on account and external id). Copies get varied amounts, and half get a
 * memo, from a seeded source: identical copies would compress to nothing and understate the write. The same seed
 * always makes the same book, so two runs time the same thing.
 */
export function inflate(base: DatabaseSnapshot, factor: number, seed = 1): DatabaseSnapshot {
  const rng = random(seed)
  return {
    meta: base.meta,
    collections: base.collections.map(c => c.name !== GROWING || factor <= 1 ? c : {
      ...c,
      docs: Array.from({ length: factor }, (_, k) => c.docs.map(doc => {
        if (k === 0) return doc
        const externalId = (doc as { externalId?: unknown }).externalId
        return {
          ...doc,
          id: `${doc.id}~${k}`,
          ...(typeof externalId === 'string' && { externalId: `${externalId}~${k}` }),
          amount: -rng.int(1, 500_000),
          ...(rng.chance(0.5) && { memo: rng.next().toString(36).slice(2, 12) })
        }
      })).flat().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    })
  }
}

export const documentCount = (snapshot: DatabaseSnapshot) => snapshot.collections.reduce((n, c) => n + c.docs.length, 0)

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

async function timed<T>(work: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now()
  const result = await work()
  return [result, performance.now() - start]
}

/**
 * Writes `snapshot` as a book in `engine`, then does what the app does with it: open it, snapshot it, write a
 * backup, verify the backup, and restore it into a new book. `runs` times over, in a fresh folder under `work`
 * each time; reports the median of each step. Everything it writes is removed.
 */
export async function measure(engine: string, snapshot: DatabaseSnapshot, factor: number, work: string, runs = 1): Promise<Row> {
  const make = ENGINES[engine]
  if (!make) throw new Error(`Unknown engine "${engine}": use ${Object.keys(ENGINES).join(' or ')}`)
  const disk = nodeBackupDisk()
  const samples: Omit<Row, 'engine' | 'factor' | 'documents'>[] = []

  for (let run = 0; run < runs; run++) {
    const dir = fs.mkdtempSync(path.join(work, `${engine}-${factor}-`))
    try {
      const bookFile = path.join(dir, 'Bench.tessera')
      const filling = make(path.join(dir, 'storage'))
      await (await filling.open({ path: bookFile })).load(snapshot)
      await filling.closeAll()

      const books = make(path.join(dir, 'storage'))
      try {
        const [db, open] = await timed(() => books.open({ path: bookFile }))
        const [taken, snap] = await timed(() => db.snapshot())
        const header = backupHeader({ book: { id: 'bench', name: 'Bench', path: bookFile }, takenAt: new Date(), trigger: 'auto', app: 'bench', engine: books.id }, taken)
        const folder = path.join(dir, 'backups')
        fs.mkdirSync(folder)
        const [file, write] = await timed(() => disk.create(folder, n => backupFileName('Bench', new Date(), 'auto', n),
          async out => { await writeBackup(out, header, taken) }))
        const [, verify] = await timed(() => verifyBackup(disk.open(file)))
        const [, restore] = await timed(async () => {
          const { snapshot: read } = await readBackup(disk.open(file))
          const restored = await books.open({ path: path.join(dir, 'Restored.tessera') })
          await restored.load(read)
          await restored.close()
        })
        samples.push({
          bookBytes: fs.statSync(bookFile).size, backupBytes: fs.statSync(file).size,
          open, snapshot: snap, write, quit: snap + write, verify, restore
        })
      } finally {
        await books.closeAll()
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  const of = (key: keyof (typeof samples)[number]) => median(samples.map(s => s[key]))
  return {
    engine, factor, documents: documentCount(snapshot),
    bookBytes: of('bookBytes'), backupBytes: of('backupBytes'),
    open: of('open'), snapshot: of('snapshot'), write: of('write'), quit: of('quit'), verify: of('verify'), restore: of('restore')
  }
}

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`
const ms = (value: number) => Math.round(value).toLocaleString('en-US')

/** The rows as a Markdown table, ready to paste into the design note. */
export function formatTable(rows: readonly Row[]): string {
  const lines = [
    '| Engine | Documents | Book | Backup | Open | Snapshot | Write | **Quit path** | Verify | Restore |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.engine} | ${r.documents.toLocaleString('en-US')} | ${mb(r.bookBytes)} | ${mb(r.backupBytes)} | ` +
      `${ms(r.open)} | ${ms(r.snapshot)} | ${ms(r.write)} | **${ms(r.quit)}** | ${ms(r.verify)} | ${ms(r.restore)} |`)
  ]
  return lines.join('\n')
}

/** Whether the slowest quit path fits the shutdown budget, and by how much. */
export function verdict(rows: readonly Row[], budgetMs: number): { fits: boolean, text: string } {
  const worst = rows.reduce<Row | undefined>((w, r) => !w || r.quit > w.quit ? r : w, undefined)
  if (!worst) return { fits: true, text: 'Nothing was measured.' }
  const fits = worst.quit <= budgetMs
  const margin = (budgetMs / Math.max(worst.quit, 1)).toFixed(1)
  return {
    fits,
    text: fits
      ? `The slowest quit path, ${ms(worst.quit)} ms (${worst.engine}, ${worst.documents.toLocaleString('en-US')} documents), fits the ${ms(budgetMs)} ms shutdown budget ${margin}× over.`
      : `The slowest quit path, ${ms(worst.quit)} ms (${worst.engine}, ${worst.documents.toLocaleString('en-US')} documents), does NOT fit the ${ms(budgetMs)} ms shutdown budget.`
  }
}
