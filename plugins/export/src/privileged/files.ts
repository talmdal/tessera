// Saving an export: the bytes are written under a temporary name beside the file, then renamed over it, so the file the
// user chose is either the whole new file or what it was before, never half written. Windows refuses a rename while
// another program holds the file (antivirus scanning it, a sync client, Excel with last month's export open), so the
// rename is retried for a while, as backups do (plugins/ledger/…/backup/rename.ts; plugins can't share code). Unlike a
// backup, an export may replace a file: the Save dialog already asked. See docs/export-design.md, "Writing the file
// safely".
import fs from 'node:fs/promises'
import path from 'node:path'
import { ExportError } from '@tessera/export-api'

/** What saving needs from the file system; tests pass their own. */
export interface ExportDisk {
  writeFile(filePath: string, bytes: Uint8Array): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(filePath: string): Promise<void>
}

export const nodeDisk: ExportDisk = {
  writeFile: (filePath, bytes) => fs.writeFile(filePath, bytes),
  rename: (from, to) => fs.rename(from, to),
  remove: filePath => fs.rm(filePath, { force: true })
}

/** The temporary file's name: the file's own, with this after it. */
export const PARTIAL_SUFFIX = '.partial'

/** The codes a file held by another program gives: EBUSY on Windows, and EPERM and EACCES, which are retried too. */
const HELD = new Set(['EBUSY', 'EPERM', 'EACCES'])

export interface SaveOptions {
  /** How long to keep trying the rename. Default 10 s. */
  budgetMs?: number
  /** For tests: how to wait, and what time it is. */
  sleep?(ms: number): Promise<void>
  now?(): number
}

const codeOf = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code ?? ''

/** Why a file couldn't be saved, as the user reads it. */
export function saveFailure(err: unknown, filePath: string): ExportError {
  const name = path.basename(filePath)
  switch (codeOf(err)) {
    case 'ENOSPC': return new ExportError('WRITE_FAILED', `There isn’t enough space on the disk to save ${name}.`)
    case 'ENOENT': return new ExportError('WRITE_FAILED', `The folder for ${name} no longer exists.`)
    case 'EROFS': return new ExportError('WRITE_FAILED', `${name} can’t be saved there: the disk is read-only.`)
    case 'EBUSY': case 'EPERM': case 'EACCES':
      return new ExportError('WRITE_FAILED', `${name} couldn’t be saved: another program may have it open, or Tessera isn’t allowed to write in that folder. Close the file in any program that has it open, then export again.`)
    default: return new ExportError('WRITE_FAILED', `${name} couldn’t be saved: ${(err as Error)?.message ?? err}`)
  }
}

/** Writes `bytes` to `filePath` safely, replacing the file if it is there. Throws an `ExportError` saying why not. */
export async function saveFile(disk: ExportDisk, filePath: string, bytes: Uint8Array, options: SaveOptions = {}): Promise<void> {
  const { budgetMs = 10_000 } = options
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = options.now ?? (() => Date.now())
  const partial = filePath + PARTIAL_SUFFIX
  try {
    await disk.writeFile(partial, bytes)
    const start = now()
    for (let wait = 50; ; wait = Math.min(wait * 2, 1000)) {
      try {
        await disk.rename(partial, filePath)
        return
      } catch (err) {
        if (!HELD.has(codeOf(err)) || now() - start >= budgetMs) throw err
        await sleep(wait)
      }
    }
  } catch (err) {
    await disk.remove(partial).catch(() => {})
    throw saveFailure(err, filePath)
  }
}
