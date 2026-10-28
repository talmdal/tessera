import type { BorderItemDescriptor, Border } from '@tessera/types'
import { useContextKeySnapshot, useLayoutActions } from '../state/ShellState'
import { BarIcon } from './BarIcon'

/** `{key}` becomes the value of that context key, and '' when it is unset. */
function interpolate(text: string, keys: Record<string, unknown>) {
  return text.replace(/\{([^{}]+)\}/g, (_match, key: string) => String(keys[key.trim()] ?? ''))
}

/**
 * A bar's row of buttons and text. A button is enabled while its command is
 * (the main process says so in the descriptor), and text follows the context
 * keys it names, so a status line updates without any request of its own.
 */
export function ItemStrip({ side, items }: { side: Border, items: BorderItemDescriptor[] }) {
  const keys = useContextKeySnapshot()
  const { execute } = useLayoutActions()

  const draw = (item: BorderItemDescriptor) => {
    const content = (
      <>
        {item.icon && <BarIcon icon={item.icon} title={item.kind === 'button' ? item.label : item.text} />}
        {item.kind === 'button' ? item.label : interpolate(item.text, keys)}
      </>
    )

    if (item.command === undefined) {
      return <span key={item.id} data-item={item.id} title={item.tooltip} style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>{content}</span>
    }

    const command = item.command
    return (
      <button key={item.id} data-item={item.id} title={item.tooltip} disabled={!item.enabled}
        aria-label={item.kind === 'button' ? item.label : undefined} onClick={() => execute(command)}
        style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
        {content}
      </button>
    )
  }

  const start = items.filter(item => item.align !== 'end')
  const end = items.filter(item => item.align === 'end')

  return (
    <div role="group" aria-label={`${side} bar items`} style={{ display: 'flex', flex: 'none', alignItems: 'center', gap: 8, padding: '2px 8px' }}>
      {start.map(draw)}
      <span style={{ marginLeft: 'auto' }} />
      {end.map(draw)}
    </div>
  )
}
