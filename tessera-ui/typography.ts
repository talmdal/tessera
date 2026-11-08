// The typography variants the shell's theme adds for font roles, made known to MUI's types, so `variant="numeric"`,
// `theme.typography.monospace` and the like type-check in the shell and in plugins (which get their types from this
// package). The shell's theme always defines both (shell/renderer/theme/fontTheme.ts). See docs/font-roles-design.md.
import type { CSSProperties } from 'react'

declare module '@mui/material/styles' {
  interface TypographyVariants {
    /** Amounts and figures: digits of equal width, in the size of the text around them. */
    numeric: CSSProperties
    /** Fixed-width text: paths, file contents. */
    monospace: CSSProperties
  }
  interface TypographyVariantsOptions {
    numeric?: CSSProperties
    monospace?: CSSProperties
  }
}

declare module '@mui/material/Typography' {
  interface TypographyPropsVariantOverrides {
    numeric: true
    monospace: true
  }
}

export {}
