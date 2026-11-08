// shared/settings/resolvePages.ts — validates `shell.settings.pages` contributions against the registered namespaces
// and orders them as the Options dialog's tree shows them.
import type { JsonObject, SettingsField, SettingsPageDescriptor } from '@tessera/types'
import { copyField, fieldDefinitionProblem } from './fields'

export interface ContributedPage {
  contributor: string
  impl: unknown
}

/** What the resolver needs to know of a registered namespace. */
export interface NamespaceInfo {
  owner: string
  defaults: JsonObject
}

const isText = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0
const owns = (owner: string, id: string) => id === owner || id.startsWith(`${owner}.`)

interface Candidate {
  page: SettingsPageDescriptor
  order: number
  seq: number
}

/**
 * Validates the contributions. A page is skipped, with a diagnostic, when its id isn't its contributor's, it has no
 * title, it has both a `module` and `fields`, or it edits a namespace its contributor didn't register. A field that
 * doesn't suit the namespace's defaults is left out of its page (a page left with no fields is skipped). A page whose
 * parent is unknown, or part of a cycle, is shown at the top level. The first of two pages with one id wins.
 *
 * The result is in tree order: each page is followed by the pages under it, siblings by `order`, then registration.
 */
export function resolveSettingsPages(
  contributions: readonly ContributedPage[],
  namespaceOf: (id: string) => NamespaceInfo | undefined
): { pages: SettingsPageDescriptor[], diagnostics: string[] } {
  const diagnostics: string[] = []
  const byId = new Map<string, Candidate>()

  contributions.forEach(({ contributor, impl }, seq) => {
    const result = validate(impl, contributor, namespaceOf)
    diagnostics.push(...result.diagnostics)
    if (!result.page) return
    if (byId.has(result.page.id)) {
      diagnostics.push(`Duplicate settings page id "${result.page.id}" ignored`)
      return
    }
    byId.set(result.page.id, { page: result.page, order: result.order, seq })
  })

  // A parent that doesn't exist, or that leads back to the page, is dropped: the page goes to the top level.
  for (const candidate of byId.values()) {
    const { page } = candidate
    if (page.parent === undefined) continue
    if (!byId.has(page.parent)) {
      diagnostics.push(`Settings page "${page.id}" names an unknown parent "${page.parent}"; it is shown at the top level`)
      delete page.parent
      continue
    }
    // Walk up from the page; reaching it again means it is in a cycle. A cycle above it (not through it) is broken
    // when its own pages are checked.
    let cyclic = page.parent === page.id
    const visited = new Set([page.id])
    for (let at = byId.get(page.parent); !cyclic && at?.page.parent !== undefined && !visited.has(at.page.id); at = byId.get(at.page.parent)) {
      visited.add(at.page.id)
      cyclic = at.page.parent === page.id
    }
    if (cyclic) {
      diagnostics.push(`Settings page "${page.id}" is part of a cycle of parents; it is shown at the top level`)
      delete page.parent
    }
  }

  const children = new Map<string | undefined, Candidate[]>()
  for (const candidate of byId.values()) {
    const siblings = children.get(candidate.page.parent) ?? []
    siblings.push(candidate)
    children.set(candidate.page.parent, siblings)
  }

  const pages: SettingsPageDescriptor[] = []
  const placed = new Set<string>()
  const visit = (parent: string | undefined) => {
    const siblings = (children.get(parent) ?? []).sort((a, b) => a.order - b.order || a.seq - b.seq)
    for (const { page } of siblings) {
      if (placed.has(page.id)) continue
      placed.add(page.id)
      pages.push(page)
      visit(page.id)
    }
  }
  visit(undefined)

  return { pages, diagnostics }
}

function validate(raw: unknown, contributor: string, namespaceOf: (id: string) => NamespaceInfo | undefined):
  { page?: SettingsPageDescriptor, order: number, diagnostics: string[] } {
  const fail = (message: string) => ({ order: 0, diagnostics: [message] })
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('Settings page contribution is not an object')

  const p = raw as Record<string, unknown>
  if (!isText(p.id)) return fail('Settings page contribution is missing an id')
  const id = p.id
  if (!id.startsWith(`${contributor}.`)) return fail(`Settings page "${id}" ignored: its id must start with "${contributor}."`)
  if (!isText(p.title)) return fail(`Settings page "${id}" is missing a title`)
  if (p.parent !== undefined && !isText(p.parent)) return fail(`Settings page "${id}" has an invalid parent`)
  if (p.description !== undefined && typeof p.description !== 'string') return fail(`Settings page "${id}" has an invalid description`)
  if (p.order !== undefined && (typeof p.order !== 'number' || !Number.isFinite(p.order))) return fail(`Settings page "${id}" has an invalid order`)
  if (p.keywords !== undefined && (!Array.isArray(p.keywords) || p.keywords.some(k => typeof k !== 'string'))) {
    return fail(`Settings page "${id}" has invalid keywords; use a list of words`)
  }
  if (p.module !== undefined && p.fields !== undefined) return fail(`Settings page "${id}" has both a module and fields; use one`)
  if (p.module !== undefined && (!isText(p.module) || !p.module.startsWith('./'))) {
    return fail(`Settings page "${id}" must name an exposed module like "./MySettingsPage"`)
  }
  if (p.fields !== undefined && !Array.isArray(p.fields)) return fail(`Settings page "${id}" has fields that are not a list`)

  const hasContent = p.module !== undefined || p.fields !== undefined
  if (p.settings !== undefined && !hasContent) return fail(`Settings page "${id}" names settings but has no module or fields to edit them with`)

  const base: SettingsPageDescriptor = {
    id,
    title: p.title as string,
    pluginId: contributor,
    keywords: (p.keywords as string[] | undefined)?.filter(k => k.trim() !== '') ?? [],
    ...(p.parent !== undefined && { parent: p.parent as string }),
    ...(p.description !== undefined && { description: p.description as string })
  }
  const order = (p.order as number | undefined) ?? 0
  if (!hasContent) return { page: base, order, diagnostics: [] }

  const settings = p.settings ?? contributor
  if (!isText(settings)) return fail(`Settings page "${id}" has an invalid settings id`)
  if (!owns(contributor, settings)) return fail(`Settings page "${id}" ignored: it may only edit "${contributor}" settings, not "${settings}"`)
  const namespace = namespaceOf(settings)
  if (!namespace || namespace.owner !== contributor) return fail(`Settings page "${id}" ignored: settings "${settings}" are not registered`)

  if (p.module !== undefined) return { page: { ...base, settings, module: p.module as string }, order, diagnostics: [] }

  const diagnostics: string[] = []
  const fields: SettingsField[] = []
  const keys = new Set<string>()
  for (const raw of p.fields as unknown[]) {
    const problem = fieldDefinitionProblem(raw, namespace.defaults)
    const field = raw as SettingsField
    if (problem) diagnostics.push(`Settings page "${id}": ${problem}; the field is left out`)
    else if (keys.has(field.key)) diagnostics.push(`Settings page "${id}": field "${field.key}" appears twice; the second is left out`)
    else {
      keys.add(field.key)
      fields.push(copyField(field))
    }
  }
  if (fields.length === 0) return { order, diagnostics: [...diagnostics, `Settings page "${id}" ignored: it has no usable fields`] }
  return { page: { ...base, settings, fields }, order, diagnostics }
}
