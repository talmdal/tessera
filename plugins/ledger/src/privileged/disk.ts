// The file-system questions the ledger asks, behind a port so the session can be tested without files.
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

/** What a file's first bytes say it is. */
export type FileKind = 'sqlite' | 'json' | 'empty' | 'unknown'

export interface LedgerDisk {
  exists(file: string): Promise<boolean>
  /** Reads the first bytes only; never changes the file. */
  sniff(file: string): Promise<FileKind>
  /**
   * Whether a SQLite file is in WAL mode, from its header (bytes 18 and 19 are 2 for WAL, 1 for a rollback journal),
   * without opening it. Opened read-only, a file in WAL mode leaves `-wal` and `-shm` files beside it. False for
   * anything that isn't a SQLite file.
   */
  walMode(file: string): Promise<boolean>
  /** Files a storage engine keeps beside a database (`-wal`, `-shm`, `-journal`, `~`) that exist now. */
  sideFiles(file: string): Promise<string[]>
  /** Copies a file and its side files, each to the same name with `to` in place of `file`. */
  copyWithSideFiles(file: string, to: string): Promise<void>
  /** The files directly in a folder (not in folders inside it), as full paths; [] for a missing folder. */
  list(folder: string): Promise<string[]>
  /** Renames a file. Fails as the platform does (on Windows, EBUSY while another program holds it). */
  rename(from: string, to: string): Promise<void>
  /** Deletes a file for good; nothing happens if it isn't there. */
  remove(file: string): Promise<void>
  /** Creates a folder and any missing parents. */
  mkdir(folder: string): Promise<void>
  /** The path with links resolved, so two spellings of one folder compare equal; the path itself if it doesn't exist. */
  realpath(file: string): Promise<string>
  /**
   * Copies a file to a new one (EEXIST if `to` exists: never overwrites), calling `onProgress` with the fraction
   * copied, and makes the copy durable before resolving. A failed copy is removed.
   */
  copy(from: string, to: string, onProgress?: (done: number) => void): Promise<void>
  /** Size in bytes, and when the file last changed. */
  stat(file: string): Promise<{ size: number, modified: Date }>
  /** Whether a folder is there. */
  isFolder(folder: string): Promise<boolean>
}

/** Suffixes of the files SQLite (write-ahead log, shared memory, rollback journal) and LokiJS (temporary save) keep. */
export const SIDE_FILE_SUFFIXES = ['-wal', '-shm', '-journal', '~'] as const

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1')

/** Classifies a file from its first bytes. */
export function classify(head: Buffer): FileKind {
  if (head.length === 0) return 'empty'
  if (head.length >= SQLITE_HEADER.length && head.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) return 'sqlite'
  const text = head.toString('utf8').replace(/^\uFEFF/, '').trimStart()
  return text.startsWith('{') || text.startsWith('[') ? 'json' : 'unknown'
}

export function nodeDisk(): LedgerDisk {
  const exists = async (file: string) => {
    try { await fs.promises.access(file); return true } catch { return false }
  }

  return {
    exists,

    async sniff(file) {
      const handle = await fs.promises.open(file, 'r')
      try {
        const head = Buffer.alloc(64)
        const { bytesRead } = await handle.read(head, 0, head.length, 0)
        return classify(head.subarray(0, bytesRead))
      } finally {
        await handle.close()
      }
    },

    async walMode(file) {
      const handle = await fs.promises.open(file, 'r')
      try {
        const head = Buffer.alloc(20)
        const { bytesRead } = await handle.read(head, 0, head.length, 0)
        return classify(head.subarray(0, bytesRead)) === 'sqlite' && bytesRead === 20 && head[18] === 2
      } finally {
        await handle.close()
      }
    },

    async sideFiles(file) {
      const found: string[] = []
      for (const suffix of SIDE_FILE_SUFFIXES) if (await exists(file + suffix)) found.push(file + suffix)
      return found
    },

    async list(folder) {
      try {
        const entries = await fs.promises.readdir(folder, { withFileTypes: true })
        return entries.filter(entry => entry.isFile()).map(entry => path.join(folder, entry.name))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw err
      }
    },

    rename: (from, to) => fs.promises.rename(from, to),

    remove: file => fs.promises.rm(file, { force: true }),

    async mkdir(folder) { await fs.promises.mkdir(folder, { recursive: true }) },

    async realpath(file) {
      try { return await fs.promises.realpath(file) } catch { return path.resolve(file) }
    },

    async copy(from, to, onProgress) {
      const { size } = await fs.promises.stat(from)
      let copied = 0
      const source = fs.createReadStream(from)
      source.on('data', chunk => {
        copied += chunk.length
        if (size > 0) onProgress?.(Math.min(1, copied / size))
      })
      try {
        // 'wx': never over a file already there
        await pipeline(source, fs.createWriteStream(to, { flags: 'wx' }))
        const written = await fs.promises.open(to, 'r+')
        try { await written.sync() } finally { await written.close() }
      } catch (err) {
        // Not the file that was there: only remove what this copy made
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') await fs.promises.rm(to, { force: true }).catch(() => {})
        throw err
      }
      onProgress?.(1)
    },

    async isFolder(folder) {
      try { return (await fs.promises.stat(folder)).isDirectory() } catch { return false }
    },

    async stat(file) {
      const stats = await fs.promises.stat(file)
      return { size: stats.size, modified: stats.mtime }
    },

    async copyWithSideFiles(file, to) {
      await fs.promises.mkdir(path.dirname(to), { recursive: true })
      // COPYFILE_EXCL: never overwrite an earlier backup
      await fs.promises.copyFile(file, to, fs.constants.COPYFILE_EXCL)
      for (const suffix of SIDE_FILE_SUFFIXES) {
        if (await exists(file + suffix)) await fs.promises.copyFile(file + suffix, to + suffix, fs.constants.COPYFILE_EXCL)
      }
    }
  }
}
