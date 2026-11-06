// The file-system questions the ledger asks, behind a port so the session can be tested without files.
import fs from 'node:fs'
import path from 'node:path'

/** What a file's first bytes say it is. */
export type FileKind = 'sqlite' | 'json' | 'empty' | 'unknown'

export interface LedgerDisk {
  exists(file: string): Promise<boolean>
  /** Reads the first bytes only; never changes the file. */
  sniff(file: string): Promise<FileKind>
  /** Files a storage engine keeps beside a database (`-wal`, `-shm`, `-journal`, `~`) that exist now. */
  sideFiles(file: string): Promise<string[]>
  /** Copies a file and its side files, each to the same name with `to` in place of `file`. */
  copyWithSideFiles(file: string, to: string): Promise<void>
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

    async sideFiles(file) {
      const found: string[] = []
      for (const suffix of SIDE_FILE_SUFFIXES) if (await exists(file + suffix)) found.push(file + suffix)
      return found
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
