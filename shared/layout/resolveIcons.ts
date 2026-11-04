// shared/layout/resolveIcons.ts
import type { RegisteredIcon } from '@tessera/types'
import { iconFileProblem } from './icons'

export interface ContributedIcon {
  contributor: string
  impl: unknown
}

/**
 * Validates `shell.icons` contributions: `{ id, file }`, where `id` is
 * `<pluginId>.<name>` and `file` is an `.svg` inside the plugin's renderer
 * folder (starting with `./`), turned into a URL by `iconUrlFor`. Invalid ones
 * are skipped and described in `diagnostics`; the first of two with the same id wins.
 */
export function resolveIcons(
  contributions: readonly ContributedIcon[],
  iconUrlFor: (pluginId: string, relativePath: string) => string | undefined
): { icons: RegisteredIcon[], diagnostics: string[] } {
  const diagnostics: string[] = []
  const icons: RegisteredIcon[] = []
  const seen = new Set<string>()

  for (const { contributor, impl } of contributions) {
    const problem = validate(impl, contributor)
    if (problem) { diagnostics.push(problem); continue }

    const { id, file } = impl as { id: string, file: string }
    if (seen.has(id)) { diagnostics.push(`Duplicate icon id "${id}" ignored`); continue }

    const url = iconUrlFor(contributor, file.slice(2))
    if (!url) { diagnostics.push(`Icon "${id}" ignored: "${contributor}" has no renderer entry to serve "${file}"`); continue }

    seen.add(id)
    icons.push({ id, url, pluginId: contributor })
  }

  return { icons, diagnostics }
}

function validate(raw: unknown, contributor: string): string | undefined {
  if (typeof raw !== 'object' || raw === null) return 'Icon contribution is not an object'

  const { id, file, ...rest } = raw as Record<string, unknown>
  if (typeof id !== 'string' || id.length === 0) return 'Icon contribution is missing an id'
  if (!id.startsWith(`${contributor}.`) || id.length === contributor.length + 1) return `Icon "${id}" must have an id prefixed by "${contributor}."`
  if (typeof file !== 'string' || !file.startsWith('./')) return `Icon "${id}" needs a file starting with "./"`
  const fileProblem = iconFileProblem(file)
  if (fileProblem) return `Icon "${id}": ${fileProblem}`
  if (!file.toLowerCase().endsWith('.svg')) return `Icon "${id}" must be an .svg file`

  const unknown = Object.keys(rest)
  if (unknown.length > 0) return `Icon "${id}" has an unknown field "${unknown[0]}"`
  return undefined
}

/** A predicate for the ids registered by `shell.icons` contributions, for validating other contributions' icons. */
export function isRegisteredIconIn(
  contributions: readonly ContributedIcon[],
  iconUrlFor: (pluginId: string, relativePath: string) => string | undefined
): (id: string) => boolean {
  const ids = new Set(resolveIcons(contributions, iconUrlFor).icons.map(icon => icon.id))
  return id => ids.has(id)
}
