// plugins/theme.sample/src/privileged/index.ts
//
// A sample plugin that exercises the style manager's two extension points:
//
//   shell.colors  one token of its own, defaulting to a shell token, so it
//                 follows whatever theme is active unless a theme says otherwise
//   shell.themes  one theme, a sepia tint that extends the shell's light theme
//                 and overrides a handful of entries, including another
//                 plugin's token
//
// and a main-area view that shows every resolved token as a swatch, reached
// from the View menu. Nothing here touches CSS: contributions are data, the
// shell resolves them, and the view reads the result.
import type { PluginContext } from '@tessera/types'
import { COMMANDS, HIGHLIGHT_TOKEN, PLUGIN_ID, SEPIA_THEME, VIEWS } from '../shared'

export function activate(context: PluginContext) {
  // ---- The plugin's own colour token ------------------------------------------

  context.subscriptions.push(
    context.extensions.contribute(PLUGIN_ID, 'shell.colors', HIGHLIGHT_TOKEN, {
      id: HIGHLIGHT_TOKEN,
      description: 'Background of the active theme in the sample swatches',
      defaults: 'shell.warning'                     // a reference: follows the theme's warning colour
    })
  )

  // ---- A theme: a sepia tint over the shell's light theme ----------------------

  context.subscriptions.push(
    context.extensions.contribute(PLUGIN_ID, 'shell.themes', SEPIA_THEME, {
      id: SEPIA_THEME,
      label: 'Sample Sepia',
      kind: 'light',
      extends: 'shell.light',
      colors: {
        'shell.background': '#fbf6ea',
        'shell.foreground': '#3b2f1e',
        'shell.foregroundMuted': '#7d6b4f',
        'shell.border': '#d9cba6',
        'shell.accent': '#7a5c1e',
        'shell.bar.background': '#efe6cf',
        'shell.bar.hoverBackground': '#e3d6b5',
        'shell.tab.border': '#e3d6b5',
        'shell.selectionBackground': '#ecd9a8',
        [HIGHLIGHT_TOKEN]: '#f2e3b8'                // its own token, explicitly
      }
    })
  )

  // ---- A view that shows the result, and a way to reach it --------------------

  const show = async () => {
    if (!context.commands.has('shell.layout.reveal')) return
    await context.commands.execute('shell.layout.reveal', VIEWS.swatches)
  }

  context.commands.register(COMMANDS.show, show)

  context.subscriptions.push(
    context.extensions.contribute(PLUGIN_ID, 'shell.views', VIEWS.swatches, {
      id: VIEWS.swatches, title: 'Theme Swatches', slot: 'shell.main', module: './Swatches', order: 100
    }),
    context.extensions.contribute(PLUGIN_ID, 'shell.menus', `${PLUGIN_ID}.menu.show`, {
      kind: 'item', id: `${PLUGIN_ID}.menu.show`, label: 'Theme &Swatches',
      parent: 'shell.view', command: COMMANDS.show
    })
  )
}
