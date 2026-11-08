// shared/settings/search.ts — the Options dialog's search box: which pages a query finds.
import type { SettingsPageDescriptor } from '@tessera/types'

/** The words of a query, lower case. */
const wordsOf = (query: string) => query.toLocaleLowerCase().split(/\s+/).filter(word => word !== '')

/** Everything a page can be found by: its title, description and keywords, and its fields' labels, help and options. */
function textOf(page: SettingsPageDescriptor): string {
  return [
    page.title, page.description ?? '', ...page.keywords,
    ...(page.fields ?? []).flatMap(field => [
      field.label, field.description ?? '',
      ...(field.kind === 'choice' ? field.options.flatMap(option => [option.label, option.description ?? '']) : [])
    ])
  ].join('\n').toLocaleLowerCase()
}

/** True when every word of the query appears somewhere in what the page can be found by. An empty query finds all. */
export function pageMatches(page: SettingsPageDescriptor, query: string): boolean {
  const text = textOf(page)
  return wordsOf(query).every(word => text.includes(word))
}

/**
 * The pages to list for a query: those it finds, and the pages above them, so each is shown where it belongs in the
 * tree. `matched` holds only the pages found.
 */
export function searchPages(pages: readonly SettingsPageDescriptor[], query: string): { shown: Set<string>, matched: Set<string> } {
  const matched = new Set(pages.filter(page => pageMatches(page, query)).map(page => page.id))
  const byId = new Map(pages.map(page => [page.id, page]))
  const shown = new Set<string>()
  for (const id of matched) {
    for (let at = byId.get(id); at && !shown.has(at.id); at = at.parent === undefined ? undefined : byId.get(at.parent)) {
      shown.add(at.id)
    }
  }
  return { shown, matched }
}
