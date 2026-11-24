// shell/main/dialogs/writeFile.ts — `shell.files.writeFile`: a file written whole or not at all. The data goes under a
// temporary name beside the file, which is then renamed over it, so the file is either the whole new one or what it
// was before, never half written. Windows refuses a rename while another program holds the file (antivirus scanning
// it, a sync client, a spreadsheet with last month's report open), so the rename is retried for a while, as the
// export's `saveFile` and the backup's `renameWithRetry` do: this is the shell's copy, for every plugin
// (docs/reporting-design.md, "Printing and exporting"; docs/export-design.md, "Writing the file safely").
import fs from 'node:fs/promises'
import path from 'node:path'

/** What writing needs from the file system; tests pass their own. */
export interface WriteDisk {
  writeFile(filePath: string, bytes: Uint8Array): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(filePath: string): Promise<void>
}

export const nodeWriteDisk: WriteDisk = {
  writeFile: (filePath, bytes) => fs.writeFile(filePath, bytes),
  rename: (from, to) => fs.rename(from, to),
  remove: filePath => fs.rm(filePath, { force: true })
}

/** The temporary file's name: the file's own, with this after it. */
export const PARTIAL_SUFFIX = '.partial'

/** The codes a file held by another program gives: EBUSY on Windows, and EPERM and EACCES, which are retried too. */
const HELD = new Set(['EBUSY', 'EPERM', 'EACCES'])

export interface WriteOptions {
  /** How long to keep trying the rename. Default 10 s. */
  budgetMs?: number
  /** For tests: how to wait, and what time it is. */
  sleep?(ms: number): Promise<void>
  now?(): number
}

const codeOf = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code ?? ''

/** Why a file couldn't be written, in words for the user; the error it came from is its `cause`, its code kept. */
export function writeFailure(err: unknown, filePath: string): Error {
  const name = path.basename(filePath)
  const code = codeOf(err)
  const message = (() => {
    switch (code) {
      case 'ENOSPC': return `There isn’t enough space on the disk to save ${name}.`
      case 'ENOENT': return `The folder for ${name} no longer exists.`
      case 'EROFS': return `${name} can’t be saved there: the disk is read-only.`
      case 'EBUSY': case 'EPERM': case 'EACCES':
        return `${name} couldn’t be saved: another program may have it open, or Tessera isn’t allowed to write in that folder. Close the file in any program that has it open, then try again.`
      default: return `${name} couldn’t be saved: ${(err as Error)?.message ?? err}`
    }
  })()
  return Object.assign(new Error(message, { cause: err }), code ? { code } : {})
}

/** Writes `data` to `filePath` whole or not at all, replacing the file if it is there. Text is written as UTF-8. */
export async function writeFileAtomically(disk: WriteDisk, filePath: string, data: Uint8Array | string, options: WriteOptions = {}): Promise<void> {
  const { budgetMs = 10_000 } = options
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = options.now ?? (() => Date.now())
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
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
    throw writeFailure(err, filePath)
  }
}
