// shared/menus/normalize.ts
import { MenuNode } from './types'

/**
 * Prepares resolved menu children for display, recursively:
 * - drops submenus that end up empty
 * - consolidates adjacent separators into one
 * - removes leading and trailing separators
 */
export function normalizeMenuNodes(nodes: readonly MenuNode[]): MenuNode[] {
  const out: MenuNode[] = []

  for (const node of nodes) {
    if (node.type === 'submenu') {
      const children = normalizeMenuNodes(node.children)
      if (children.length > 0) out.push({ ...node, children })
      continue
    }

    if (node.type === 'separator' && (out.length === 0 || out[out.length - 1].type === 'separator')) {
      continue
    }

    out.push(node)
  }

  if (out.length > 0 && out[out.length - 1].type === 'separator') out.pop()

  return out
}
