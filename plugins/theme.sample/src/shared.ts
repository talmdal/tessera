// plugins/theme.sample/src/shared.ts
//
// The contract between the plugin's two halves: the ids it registers. The
// view itself talks only to the shell (the theme snapshot and event, and the
// CSS variables), so there is no plugin IPC here.

export const PLUGIN_ID = 'theme-sample'

/** The one colour token the plugin owns; its views use it, and any theme may colour it. */
export const HIGHLIGHT_TOKEN = `${PLUGIN_ID}.highlight`

/** The theme the plugin ships. */
export const SEPIA_THEME = `${PLUGIN_ID}.sepia`

export const COMMANDS = {
  show: `${PLUGIN_ID}.show`
} as const

export const VIEWS = {
  swatches: `${PLUGIN_ID}.swatches`
} as const
