import { Icon } from '@tessera/ui'

/**
 * An icon for a bar view or item: a standard icon, a plugin's registered one, or a plugin's file (a URL).
 * Anything else, such as a view whose icon has not arrived yet, or an icon still loading, shows the initial
 * of `title` at the same size, so nothing shifts when it arrives.
 */
export function BarIcon({ icon, title }: { icon?: string, title: string }) {
  return <Icon name={icon ?? ''} fallback={title} fontSize="small" />
}
