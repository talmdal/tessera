// plugins/theme-halloween/src/privileged/index.ts
//
// A theme plugin: a manifest, this entry, and a JSON file. The JSON is a
// `ThemeContribution` (see @tessera/types): MUI theme options for a light and
// a dark scheme over the shell's base theme. The build bundles it into this
// entry, and `activate` contributes it under `shell.themes`; the shell
// validates it, lists it in View › Theme, and builds it in the renderer when
// the user chooses it. Pushing the disposable means the theme goes when the
// plugin does, and the shell falls back to its own.
import type { PluginContext, ThemeContribution } from '@tessera/types'
import halloween from '../../themes/halloween.json'

export const PLUGIN_ID = 'theme-halloween'
export const THEMES_EXTENSION_POINT = 'shell.themes'

export function activate(context: PluginContext) {
  const theme = halloween as ThemeContribution
  context.subscriptions.push(
    context.extensions.contribute(PLUGIN_ID, THEMES_EXTENSION_POINT, theme.id, theme)
  )
  context.logger.info(`[${PLUGIN_ID}] contributed theme "${theme.label}"`)
}
