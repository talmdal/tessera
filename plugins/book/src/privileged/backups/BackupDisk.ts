// The file system as backups need it, behind a port so the scheduler and the restorer can be tested without
// files. `nodeBackupDisk` is the real one. See docs/backup-restore-design.md, "Writing".
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { isBackupFileName, PARTIAL_SUFFIX } from './naming'

export interface BackupFileInfo {
  file: string
  size: number
  modifiedAt: Date
}

export interface BackupDisk {
  /** Whether `folder` exists and is a folder. */
  folderExists(folder: string): Promise<boolean>
  /** Creates `folder` and any missing parents. Only for the default backup folder: a chosen one is never created. */
  makeFolder(folder: string): Promise<void>
  /**
   * Writes a new file into `folder`. `write` fills a `.partial` file and ends the stream; the file is then synced
   * to disk and renamed to `name(1)`, or `name(2)`… when that is taken, so nothing is ever overwritten. If `write`
   * fails the partial file is removed, so a file under a final name is always complete. Resolves the final path.
   */
  create(folder: string, name: (attempt: number) => string, write: (out: Writable) => Promise<void>): Promise<string>
  /**
   * Writes exactly `file`, as `create` writes: through a `.partial` file beside it, synced, then renamed over `file`,
   * replacing one already there (the user chose it, and the save dialog asked first). Fails if its folder is missing.
   */
  write(file: string, write: (out: Writable) => Promise<void>): Promise<void>
  /** The file's bytes, as a stream. */
  open(file: string): Readable
  /** A file's size and time; rejects if it isn't there. */
  stat(file: string): Promise<BackupFileInfo>
  /** The backups directly in `folder`, by extension; never a `.partial` file. */
  list(folder: string): Promise<BackupFileInfo[]>
  /** Ordinary Tessera book files directly in an archive folder, excluding staged/writing files. */
  listArchives?(folder: string): Promise<BackupFileInfo[]>
  /** The `.partial` files directly in `folder`, left by a write that never finished. */
  partials(folder: string): Promise<BackupFileInfo[]>
  /** Deletes a file. No error if it is already gone. */
  remove(file: string): Promise<void>
}

/** How many names `create` tries before giving up: only reachable if a folder is full of same-second backups. */
export const MAX_NAME_ATTEMPTS = 100

export function nodeBackupDisk(): BackupDisk {
  const exists = async (file: string) => {
    try { await fs.promises.access(file); return true } catch { return false }
  }

  const filesIn = async (folder: string, wanted: (name: string) => boolean): Promise<BackupFileInfo[]> => {
    const found: BackupFileInfo[] = []
    for (const entry of await fs.promises.readdir(folder, { withFileTypes: true })) {
      if (!entry.isFile() || !wanted(entry.name)) continue
      const file = path.join(folder, entry.name)
      try {
        const stat = await fs.promises.stat(file)
        found.push({ file, size: stat.size, modifiedAt: stat.mtime })
      } catch {
        // Removed between listing and looking: it is simply not there
      }
    }
    return found.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
  }

  /** Makes a rename durable where the platform allows it; Windows can't open a folder, and doesn't need to. */
  const syncFolder = async (folder: string) => {
    try {
      const handle = await fs.promises.open(folder, 'r')
      try { await handle.sync() } finally { await handle.close() }
    } catch { /* best effort */ }
  }

  /**
   * Fills `<file>.<random>.partial`, synced to disk and closed, and resolves its path; on failure removes it. The random
   * part means a partial file left by a crash never collides with a new one.
   */
  const writePartial = async (file: string, write: (out: Writable) => Promise<void>): Promise<string> => {
    const partial = `${file}.${randomBytes(4).toString('hex')}${PARTIAL_SUFFIX}`
    // flush: the stream syncs the file to disk before closing it, and 'close' comes after both
    const out = fs.createWriteStream(partial, { flags: 'wx', flush: true })
    try {
      await write(out)
      if (!out.closed) await once(out, 'close')
    } catch (err) {
      if (!out.closed) {
        const closed = once(out, 'close').catch(() => {})
        out.destroy()
        await closed
      }
      await fs.promises.rm(partial, { force: true })
      throw err
    }
    return partial
  }

  return {
    async folderExists(folder) {
      try { return (await fs.promises.stat(folder)).isDirectory() } catch { return false }
    },

    async makeFolder(folder) {
      await fs.promises.mkdir(folder, { recursive: true })
    },

    async create(folder, name, write) {
      const partial = await writePartial(path.join(folder, name(1)), write)

      try {
        for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
          const target = path.join(folder, name(attempt))
          // Writes are serialised in-process; only another running copy of Tessera could take the name in between
          if (await exists(target)) continue
          await fs.promises.rename(partial, target)
          await syncFolder(folder)
          return target
        }
        throw new Error(`Every name for this backup in ${folder} is taken`)
      } catch (err) {
        await fs.promises.rm(partial, { force: true })
        throw err
      }
    },

    async write(file, write) {
      const partial = await writePartial(file, write)
      try {
        await fs.promises.rename(partial, file)
        await syncFolder(path.dirname(file))
      } catch (err) {
        await fs.promises.rm(partial, { force: true })
        throw err
      }
    },

    open: file => fs.createReadStream(file),

    async stat(file) {
      const stat = await fs.promises.stat(file)
      return { file, size: stat.size, modifiedAt: stat.mtime }
    },

    list: folder => filesIn(folder, isBackupFileName),
    async listArchives(folder) {
      return filesIn(folder, name => !name.startsWith('.') &&
        name.toLowerCase().endsWith('.tessera') &&
        !name.toLowerCase().endsWith('.tessera-backup'))
    },

    partials: folder => filesIn(folder, entry => entry.endsWith(PARTIAL_SUFFIX)),

    async remove(file) {
      await fs.promises.rm(file, { force: true })
    }
  }
}
