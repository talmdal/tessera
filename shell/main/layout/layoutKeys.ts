// shell/main/layout/layoutKeys.ts
import type { ContextKeyService } from '@tessera/types'
import { LayoutService } from '../../../core/layout/LayoutService'
import { BAR_SIDES, barHasContent, layoutKey } from '../../../shared/layout/types'

/**
 * Publishes the layout as context keys, so `when` expressions and command
 * enablement can depend on it. Whether a bar has content is the same in every
 * window and is always set; the rest describes the window `target` names (the
 * focused one) and is unset while there is none. Call it after anything that
 * can change them: it only writes what differs.
 */
export function createLayoutKeys(keys: ContextKeyService, layout: LayoutService, target: () => number | undefined) {
  return function syncLayoutKeys() {
    const windowId = target()
    const state = windowId === undefined ? undefined : layout.get(windowId)

    for (const side of BAR_SIDES) {
      const bar = state?.bars[side]
      keys.set(layoutKey.hasContent(side), bar ? barHasContent(bar) : layout.hasContent(side))
      keys.set(layoutKey.collapsed(side), bar?.collapsed)
      keys.set(layoutKey.visible(side), bar ? barHasContent(bar) && !bar.collapsed : undefined)
      keys.set(layoutKey.activeView(side), bar?.activeView)
    }
    keys.set(layoutKey.mainActiveView, state?.main.activeView)
  }
}
