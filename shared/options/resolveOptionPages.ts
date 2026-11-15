// shared/options/resolveOptionPages.ts
import type { OptionsPageDescriptor } from '@tessera/types'
import { SHELL_CONTRIBUTOR_ID } from '../plugins/manifest'
import { OptionsPageNode } from './types'

export interface ContributedOptionsPage {
  contributor: string
  impl: unknown
}

interface Candidate {
  node: OptionsPageNode
  parent?: string
  order: number
  seq: number
}

/**
 * Validates `shell.options.pages` contributions and builds the dialog's navigation tree.
 *
 * Like views and menus, a bad contribution is skipped and reported rather than taken as a reason to fail: the
 * rest of the tree still builds, so one plugin's typo cannot cost the user access to everyone's options.
 *
 * `remoteEntryFor` returns a plugin's renderer remote entry, or undefined when it has none. A page that names a
 * module needs one; a category — a node with no module — does not. The shell's own pages are built in, as its
 * dialogs are: no remote entry, and the dialog resolves the module against its built-in components.
 */
export function resolveOptionPages(
  contributions: readonly ContributedOptionsPage[],
  remoteEntryFor: (pluginId: string) => string | undefined
): { pages: OptionsPageNode[], diagnostics: string[] } {
  const diagnostics: string[] = []
  const candidates = new Map<string, Candidate>()

  contributions.forEach(({ contributor, impl }, seq) => {
    const problem = validate(impl, contributor)
    if (problem) {
      diagnostics.push(problem)
      return
    }

    const page = impl as OptionsPageDescriptor
    if (candidates.has(page.id)) {
      diagnostics.push(`Duplicate option page id "${page.id}" ignored`)
      return
    }

    let remoteEntry: string | undefined
    if (page.module !== undefined && contributor !== SHELL_CONTRIBUTOR_ID) {
      remoteEntry = remoteEntryFor(contributor)
      if (!remoteEntry) {
        diagnostics.push(`Option page "${page.id}" ignored: "${contributor}" has no renderer entry`)
        return
      }
    }

    candidates.set(page.id, {
      node: {
        id: page.id,
        title: page.title,
        pluginId: contributor,
        keywords: page.keywords ? [...page.keywords] : [],
        children: [],
        ...(page.module !== undefined && { module: page.module }),
        ...(remoteEntry !== undefined && { remoteEntry })
      },
      parent: page.parent,
      order: page.order ?? 0,
      seq
    })
  })

  // Parents are resolved only once every contribution has been seen, so a page may be contributed before the
  // category it nests under — plugins activate in dependency order, not in tree order.
  const placed = new Map<string, Candidate>()
  for (const candidate of candidates.values()) {
    const problem = rootOf(candidate, candidates)
    if (problem) diagnostics.push(problem)
    else placed.set(candidate.node.id, candidate)
  }

  const roots: Candidate[] = []
  for (const candidate of placed.values()) {
    const parent = candidate.parent === undefined ? undefined : placed.get(candidate.parent)
    if (parent) parent.node.children.push(candidate.node)
    else roots.push(candidate)
  }

  const byOrder = (a: Candidate, b: Candidate) => a.order - b.order || a.seq - b.seq
  // Sorting the children arrays means sorting the candidates that own them, so every level is sorted once.
  for (const candidate of placed.values()) {
    candidate.node.children.sort((a, b) => byOrder(placed.get(a.id)!, placed.get(b.id)!))
  }

  return { pages: roots.sort(byOrder).map(candidate => candidate.node), diagnostics }
}

/** Why this page cannot be placed: an unknown parent, or a cycle. Undefined when it reaches a root. */
function rootOf(candidate: Candidate, candidates: Map<string, Candidate>): string | undefined {
  const seen = new Set<string>([candidate.node.id])
  let current = candidate

  while (current.parent !== undefined) {
    const parent = candidates.get(current.parent)
    if (!parent) return `Option page "${candidate.node.id}" ignored: unknown parent "${current.parent}"`
    if (seen.has(parent.node.id)) return `Option page "${candidate.node.id}" ignored: its parents form a cycle`
    seen.add(parent.node.id)
    current = parent
  }
  return undefined
}

function validate(raw: unknown, contributor: string): string | undefined {
  if (typeof raw !== 'object' || raw === null) return `Option page contribution from "${contributor}" is not an object`

  const page = raw as Record<string, unknown>
  const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

  if (!isString(page.id)) return `Option page contribution from "${contributor}" is missing an id`
  // The id is the user-visible handle on a page any plugin may refer to as a parent, so it is owned like a
  // command id rather than left to convention.
  if (page.id !== contributor && !page.id.startsWith(`${contributor}.`)) {
    return `Option page "${page.id}" ignored: its id must be "${contributor}" or start with "${contributor}."`
  }
  if (!isString(page.title)) return `Option page "${page.id}" is missing a title`
  if (page.parent !== undefined && !isString(page.parent)) return `Option page "${page.id}" has an invalid parent`
  if (page.parent === page.id) return `Option page "${page.id}" ignored: it is its own parent`
  if (page.module !== undefined && (!isString(page.module) || !page.module.startsWith('./'))) {
    return `Option page "${page.id}" must name an exposed module like "./MyOptionsPage"`
  }
  if (page.order !== undefined && (typeof page.order !== 'number' || !Number.isFinite(page.order))) {
    return `Option page "${page.id}" has an invalid order`
  }
  if (page.keywords !== undefined && (!Array.isArray(page.keywords) || !page.keywords.every(isString))) {
    return `Option page "${page.id}" has invalid keywords`
  }
}
