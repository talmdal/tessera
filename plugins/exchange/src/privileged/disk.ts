// The file system, behind a port, so the pipeline can be tested without touching a disk — the same shape the
// book plugin uses for its own file handling. `shell.files` offers dialogs and the trash but no bytes, and a
// privileged plugin has Node, so reading and writing live here rather than growing the shell service.
import { createHash } from 'node:crypto'

export interface ExchangeDisk {
  read(path: string): Promise<Uint8Array>
  /** Writes to a temporary file beside the target and renames over it, so an interrupted write loses nothing. */
  write(path: string, data: Uint8Array): Promise<void>
}

/** SHA-256 of a file's bytes, hex. Identifies a file that has been imported before, whatever it was called. */
export function hashOf(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** The file's own name, without its folder — never the path, which can carry a user's name. */
export function baseNameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

export function nodeDisk(): ExchangeDisk {
  return {
    async read(path) {
      const { readFile } = await import('node:fs/promises')
      return new Uint8Array(await readFile(path))
    },
    async write(path, data) {
      const { rename, unlink, writeFile } = await import('node:fs/promises')
      const temporary = `${path}.tessera-tmp`
      await writeFile(temporary, data)
      try {
        await rename(temporary, path)
      } catch (err) {
        await unlink(temporary).catch(() => undefined)
        throw err
      }
    }
  }
}
