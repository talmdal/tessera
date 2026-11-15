// shell/main/options/JsonOptionsStore.ts
//
// Tier-0 storage for options: one plain JSON file, read synchronously at startup, before any plugin activates.
// It cannot live in `app.state`, which needs a `storage.engine` that is itself a plugin, and which activates far
// too late for the shell's own options. It is a sibling of tessera-bootstrap.json, not a replacement: that file
// says which plugins run at all. See docs/options-framework-design.md.
import fs from 'node:fs'
import path from 'node:path'
import type { Logger, OptionsDocument } from '@tessera/types'
import type { OptionsStore } from '../../../core/ports'

export const OPTIONS_FILE = 'tessera-options.json'

export const optionsFilePath = (userDataDir: string) => path.join(userDataDir, OPTIONS_FILE)

/** Where a file that could not be read is kept, so the user can rescue values from it. */
export const quarantinePath = (userDataDir: string) => `${optionsFilePath(userDataDir)}.bad`

export interface JsonOptionsStoreOptions {
  /** How long writes are coalesced for. Applying a page writes once; this keeps a burst to one write. */
  delayMs?: number
}

/**
 * The options file.
 *
 * Reads never throw: a missing file is an empty document, and a damaged one is copied aside to
 * `tessera-options.json.bad`, logged, and treated as empty, so a bad file can never stop the application
 * starting. Writes replace the whole document through a temporary file, so a crash mid-write cannot leave half
 * of it; they are coalesced and settled by `flush`, which the shell calls while shutting down.
 */
export function createJsonOptionsStore(userDataDir: string, log: Logger, options: JsonOptionsStoreOptions = {}): OptionsStore {
  const { delayMs = 250 } = options
  const file = optionsFilePath(userDataDir)

  let pending: OptionsDocument | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  function quarantine(reason: string) {
    log.warn(`[options] Ignoring ${file}: ${reason}. The defaults will be used.`)
    try {
      fs.copyFileSync(file, quarantinePath(userDataDir))
      log.warn(`[options] A copy of it was kept as ${quarantinePath(userDataDir)}.`)
    } catch (err) {
      log.warn(`[options] It could not be copied aside: ${err instanceof Error ? err.message : err}`)
    }
  }

  function read(): OptionsDocument {
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`[options] Could not read ${file}: ${err instanceof Error ? err.message : err}. The defaults will be used.`)
      }
      return {}
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      quarantine(`it is not valid JSON (${err instanceof Error ? err.message : err})`)
      return {}
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      quarantine('it must hold a JSON object')
      return {}
    }
    return parsed as OptionsDocument
  }

  /** Replaces the file whole, through a temporary file in the same folder, so the rename is atomic. */
  function writeNow(document: OptionsDocument) {
    const temporary = `${file}.tmp`
    try {
      fs.mkdirSync(userDataDir, { recursive: true })
      fs.writeFileSync(temporary, JSON.stringify(document, null, 2) + '\n')
      fs.renameSync(temporary, file)
    } catch (err) {
      // Never thrown on: a failed save must not take down a commit or block the shutdown sequence.
      log.error(`[options] Could not save ${file}`, err)
      try { fs.rmSync(temporary, { force: true }) } catch { /* nothing more to do */ }
    }
  }

  function writePending() {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    if (pending === undefined) return
    const document = pending
    pending = undefined
    writeNow(document)
  }

  return {
    read,

    write(document) {
      pending = document
      if (timer) return
      timer = setTimeout(writePending, delayMs)
      // Never hold the process open for a pending write; `flush` settles it on the way out.
      timer.unref?.()
    },

    async flush() {
      writePending()
    }
  }
}
