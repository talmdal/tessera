// shared/dialogs/resolveDialogs.ts
import type { DialogSize } from '@tessera/types'
import { SHELL_CONTRIBUTOR_ID } from '../plugins/manifest'
import type { DialogDescriptor } from './types'

const SIZES: readonly DialogSize[] = ['xs', 'sm', 'md', 'lg']

export interface ContributedDialog {
  contributor: string
  impl: unknown
}

/**
 * Validates `shell.dialogs` contributions. A dialog id must start with its contributor's id (`<pluginId>.`), since
 * any plugin can open a dialog by id and must get the one it meant. `remoteEntryFor` returns a plugin's renderer
 * remote entry URL, or undefined when it has no renderer; the shell's own dialogs need none.
 */
export function resolveDialogs(
  contributions: readonly ContributedDialog[],
  remoteEntryFor: (pluginId: string) => string | undefined
): { dialogs: DialogDescriptor[], diagnostics: string[] } {
  const diagnostics: string[] = []
  const dialogs = new Map<string, DialogDescriptor>()

  for (const { contributor, impl } of contributions) {
    const problem = validate(impl, contributor)
    if (problem) {
      diagnostics.push(problem)
      continue
    }
    const dialog = impl as { id: string, title: string, module: string, size?: DialogSize }
    if (dialogs.has(dialog.id)) {
      diagnostics.push(`Duplicate dialog id "${dialog.id}" ignored`)
      continue
    }

    const builtIn = contributor === SHELL_CONTRIBUTOR_ID
    const remoteEntry = builtIn ? undefined : remoteEntryFor(contributor)
    if (!builtIn && !remoteEntry) {
      diagnostics.push(`Dialog "${dialog.id}" ignored: "${contributor}" has no renderer entry`)
      continue
    }

    dialogs.set(dialog.id, {
      id: dialog.id, title: dialog.title, module: dialog.module, size: dialog.size ?? 'sm', pluginId: contributor,
      ...(remoteEntry !== undefined && { remoteEntry })
    })
  }

  return { dialogs: [...dialogs.values()], diagnostics }
}

function validate(raw: unknown, contributor: string): string | undefined {
  if (typeof raw !== 'object' || raw === null) return 'Dialog contribution is not an object'

  const d = raw as Record<string, unknown>
  const isString = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0

  if (!isString(d.id)) return 'Dialog contribution is missing an id'
  if (!d.id.startsWith(`${contributor}.`)) return `Dialog "${d.id}" ignored: its id must start with "${contributor}."`
  if (!isString(d.title)) return `Dialog "${d.id}" is missing a title`
  if (!isString(d.module) || !d.module.startsWith('./')) return `Dialog "${d.id}" must name an exposed module like "./MyDialog"`
  if (d.size !== undefined && !SIZES.includes(d.size as DialogSize)) return `Dialog "${d.id}" has an invalid size; use one of ${SIZES.join(', ')}`
}
