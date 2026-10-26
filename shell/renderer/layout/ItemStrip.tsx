// shell/renderer/layout/ItemStrip.tsx
//
// One row of bar items: buttons bound to commands, and text driven by context
// keys. Which item ids are present is the layout's decision; this renders them.
import type { BarItemDescriptor, CommandsExecuteRequest } from '@tessera/types'
import type { ContextKeySnapshot } from '../../../shared/shellEvents'
import { COMMANDS_EXECUTE } from '../../../shared/layout/types'
import { useContextKeys, useShellBridge } from '../state/ShellState'
import { useBarItemCatalogue } from './BarItemsProvider'
import { Icon } from './Icon'

/** Replaces `{key}` with the context key's value ('' when unset). */
export function interpolate(text: string, keys: ContextKeySnapshot): string {
  return text.replace(/\{([\w.-]+)\}/g, (_, key: string) => {
    const value = keys[key]
    return value === undefined ? '' : String(value)
  })
}

export function ItemStrip({ itemIds }: { itemIds: readonly string[] }) {
  const { byId } = useBarItemCatalogue()
  const keys = useContextKeys()
  const bridge = useShellBridge()

  // Ids the catalogue doesn't know yet (its fetch is in flight) are skipped.
  const items = itemIds.map(id => byId.get(id)).filter((item): item is BarItemDescriptor => item !== undefined)
  if (items.length === 0) return null

  const run = (item: BarItemDescriptor) => {
    if (!item.command || !item.enabled) return
    const request: CommandsExecuteRequest = { id: item.command }
    bridge.invoke(COMMANDS_EXECUTE, request).catch(err =>
      console.error(`[layout] Command "${item.command}" failed`, err))
  }

  const render = (item: BarItemDescriptor) => {
    if (item.kind === 'button') {
      return (
        <button
          key={item.id}
          type="button"
          className="wm-item wm-item-button"
          title={item.tooltip}
          disabled={!item.enabled}
          onClick={() => run(item)}
          data-item-id={item.id}
        >
          <Icon icon={item.icon} />
          <span className="wm-item-label">{item.label}</span>
        </button>
      )
    }

    const text = interpolate(item.text, keys)
    if (item.command) {
      return (
        <button
          key={item.id}
          type="button"
          className="wm-item wm-item-text wm-item-clickable"
          title={item.tooltip}
          disabled={!item.enabled}
          onClick={() => run(item)}
          data-item-id={item.id}
        >
          <Icon icon={item.icon} />
          {text}
        </button>
      )
    }
    return (
      <span key={item.id} className="wm-item wm-item-text" title={item.tooltip} data-item-id={item.id}>
        <Icon icon={item.icon} />
        {text}
      </span>
    )
  }

  const start = items.filter(item => (item.align ?? 'start') === 'start')
  const end = items.filter(item => item.align === 'end')

  return (
    <div className="wm-item-strip" role="toolbar">
      <span className="wm-item-group">{start.map(render)}</span>
      <span className="wm-item-group wm-item-group-end">{end.map(render)}</span>
    </div>
  )
}
