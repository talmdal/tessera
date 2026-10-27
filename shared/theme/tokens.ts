// shared/theme/tokens.ts
//
// The shell's colour token catalogue: every colour the shell's own CSS uses,
// with its default for light and dark themes. The main process validates
// themes against it and the renderer paints its first frame from it. The
// light column is the set of literals windowManager.css used to carry, so
// the default theme looks as it always did.
//
// The catalogue grows when the shell grows a control that needs a colour,
// never ahead of one. Plugin tokens come through `shell.colors` instead.
// See docs/style-manager-design.md.
import type { ColorContribution } from '@tessera/types'

const token = (id: string, description: string, light: string, dark = light): ColorContribution =>
  ({ id, description, defaults: light === dark ? light : { light, dark } })

export const SHELL_COLOR_TOKENS: readonly ColorContribution[] = [
  // Base
  token('shell.background', 'Main area and page background', '#ffffff', '#1e1e1e'),
  token('shell.foreground', 'Text', '#1f1f1f', '#d4d4d4'),
  token('shell.foregroundMuted', 'Secondary text', '#6b6b6b', '#9d9d9d'),
  token('shell.border', 'Borders between regions', '#d0d0d0', '#3c3c3c'),
  token('shell.accent', 'Active tab underline, splitter hover, rail indicator', '#0063b1', '#3794ff'),
  token('shell.accentForeground', 'Text on the accent colour', '#ffffff'),
  token('shell.focusBorder', 'Focus outlines', 'shell.accent'),
  token('shell.link', 'Links', 'shell.accent'),
  token('shell.selectionBackground', 'Selected rows and text', '#cce4f7', '#264f78'),

  // Bars and rails
  token('shell.bar.background', 'Bars and rails', '#f3f3f3', '#252526'),
  token('shell.bar.border', "A bar's inner edge", 'shell.border'),
  token('shell.bar.hoverBackground', 'Hovered tab, rail and item buttons', '#e0e0e0', '#2a2d2e'),
  token('shell.bar.activeBackground', 'The active rail icon', 'shell.bar.hoverBackground'),
  token('shell.bar.activeIndicator', 'Inset mark on the active rail icon', 'shell.accent'),

  // Tabs
  token('shell.tab.border', 'Below the tab strip', '#e0e0e0', '#3c3c3c'),
  token('shell.tab.activeBorder', 'Under the active tab', 'shell.accent'),

  // Controls
  token('shell.button.background', 'Primary buttons', 'shell.accent'),
  token('shell.button.foreground', 'Text on primary buttons', 'shell.accentForeground'),
  token('shell.button.hoverBackground', 'Hovered primary buttons', '#005a9e', '#2b7cd3'),
  token('shell.input.background', 'Text fields', '#ffffff', '#313131'),
  token('shell.input.foreground', 'Text in text fields', 'shell.foreground'),
  token('shell.input.border', 'Text field borders', '#8e8e8e', '#3c3c3c'),

  // Dialogs (the theme chooser)
  token('shell.dialog.background', 'Dialog surface', 'shell.background', '#252526'),
  token('shell.dialog.border', 'Dialog edge', 'shell.border'),
  token('shell.dialog.shadow', 'Dialog drop shadow', '#00000040', '#00000099'),
  token('shell.overlay.background', 'Backdrop behind a modal dialog', '#00000066', '#00000099'),

  // Status
  token('shell.success', 'Positive status', '#107c10', '#89d185'),
  token('shell.warning', 'Warnings', '#9d5d00', '#cca700'),
  token('shell.error', 'Errors', '#c50f1f', '#f14c4c'),
  token('shell.info', 'Information', 'shell.accent')
]
