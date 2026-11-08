// shell/main/settings/jsonSettingsPersistence.ts — settings as plain JSON files, one per namespace:
// <userData>/settings/<namespace>.json, holding `{ "version": 1, "values": { … } }` (only what differs from the
// defaults). Settings are read before any plugin activates, so they can't be kept by a plugin, not even `app.state`:
// the storage engine it needs is a plugin that may have settings of its own. See docs/settings-design.md.
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Logger } from '@tessera/types'
import { SETTINGS_FOLDER, SETTINGS_ID_PATTERN } from '@tessera/types'
import type { SettingsPersistence, StoredSettings } from '../../../core/ports'

/** The folder under the user-data folder that holds the settings files (defined with the settings contract). */
export { SETTINGS_FOLDER }

const describe = (err: unknown) => err instanceof Error ? err.message : String(err)
const isMissing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT'

/**
 * Reads every `<id>.json` in `dir`. A file that isn't valid JSON is renamed to `<id>.json.bad` (so the user's
 * next change doesn't overwrite what might be fixed by hand) and left out; a file that can't be read is left out.
 * Either is logged, and the service then uses that namespace's defaults. Writes go through a temporary file, flushed
 * to disk and renamed over the old one, so a crash leaves the old file or the new one, never half of either.
 */
export function createJsonSettingsPersistence(dir: string, log: Pick<Logger, 'warn'>): SettingsPersistence {
  const fileOf = (id: string) => {
    if (!SETTINGS_ID_PATTERN.test(id)) throw new Error(`Invalid settings id "${id}"`)
    return path.join(dir, `${id}.json`)
  }

  return {
    async loadAll() {
      let names: string[]
      try {
        names = await fs.readdir(dir)
      } catch (err) {
        if (isMissing(err)) return {}
        throw err
      }

      const documents: Record<string, unknown> = {}
      for (const name of names.sort()) {
        const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : undefined
        if (id === undefined || !SETTINGS_ID_PATTERN.test(id)) continue
        const file = path.join(dir, name)

        let text: string
        try {
          text = await fs.readFile(file, 'utf8')
        } catch (err) {
          log.warn(`[settings] Could not read ${file}: ${describe(err)}; its defaults are used`)
          continue
        }

        try {
          documents[id] = JSON.parse(text)
        } catch (err) {
          const aside = `${file}.bad`
          try {
            await fs.rename(file, aside)
            log.warn(`[settings] ${file} is not valid JSON (${describe(err)}); it was renamed to ${path.basename(aside)} and its defaults are used`)
          } catch (renameErr) {
            log.warn(`[settings] ${file} is not valid JSON (${describe(err)}) and could not be set aside (${describe(renameErr)}); its defaults are used`)
          }
        }
      }
      return documents
    },

    async save(id: string, document: StoredSettings | undefined) {
      const file = fileOf(id)
      if (document === undefined) {
        await fs.rm(file, { force: true })
        return
      }

      await fs.mkdir(dir, { recursive: true })
      const temporary = `${file}.tmp`
      const handle = await fs.open(temporary, 'w')
      try {
        await handle.writeFile(JSON.stringify(document, null, 2) + '\n', 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.rename(temporary, file)
    }
  }
}
