// shared/theme/typography.ts
//
// The shell's typography, published as CSS variables beside the colours but
// not part of any theme: a theme cannot change them in this version. They
// are named like tokens so that making them themeable later needs no
// rename. Applied to the document root by the renderer's <StyleManager>.
// See docs/style-manager-design.md.

export const SHELL_TYPOGRAPHY: Readonly<Record<string, string>> = {
  'shell.font.family': 'system-ui, sans-serif',
  'shell.font.size': '13px',
  'shell.font.sizeSmall': '12px',
  'shell.font.sizeLarge': '15px',
  'shell.font.monoFamily': 'ui-monospace, Consolas, monospace'
}
