// The file-system questions the book asks, behind a port so the session can be tested without files.
import fs from 'node:fs'
import path from 'node:path'

/** What a file's first bytes say it is. */
export type FileKind = 'sqlite' | 'json' | 'empty' | 'unknown'

export interface BookDisk {
  exists(file: string): Promise<boolean>
  /** Reads the first bytes only; never changes the file. */
  sniff(file: string): Promise<FileKind>
  /** Files a storage engine keeps beside a database (`-wal`, `-shm`, `-journal`, `~`) that exist now. */
  sideFiles(file: string): Promise<string[]>
  /** Copies a file and its side files, each to the same name with `to` in place of `file`. */
  copyWithSideFiles(file: string, to: string): Promise<void>
  /**
   * Renames a closed database file and its side files, each to the same name with `to` in place of `file`. The side
   * files go with it rather than being deleted: SQLite pairs a write-ahead log with its database by name, and even a
   * read-only connection leaves one behind. `to` must not exist: on Windows a rename can't replace a file.
   */
  renameWithSideFiles(file: string, to: string): Promise<void>
  /** Deletes a file and its side files. No error for any that are already gone. For staging files only. */
  removeWithSideFiles(file: string): Promise<void>
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

export function nodeDisk(): BookDisk {
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

    async sideFiles(file) {
      const found: string[] = []
      for (const suffix of SIDE_FILE_SUFFIXES) if (await exists(file + suffix)) found.push(file + suffix)
      return found
    },

    async renameWithSideFiles(file, to) {
      // The side files first: if the main file's rename then fails, the book is still whole under its old name,
      // its side files beside the new one, and both are found by the same rename again
      for (const suffix of SIDE_FILE_SUFFIXES) {
        if (await exists(file + suffix)) await fs.promises.rename(file + suffix, to + suffix)
      }
      await fs.promises.rename(file, to)
    },

    async removeWithSideFiles(file) {
      for (const suffix of ['', ...SIDE_FILE_SUFFIXES]) await fs.promises.rm(file + suffix, { force: true })
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
