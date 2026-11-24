// The palette entries the shell's theme adds, made known to MUI's types, so `theme.palette.chart` type-checks in the
// shell and in plugins (which get their types from this package). The shell's theme always defines it
// (shell/renderer/theme/createShellTheme.ts): twelve colours for charts' series, the theme's own or the shell's.
declare module '@mui/material/styles' {
  interface Palette {
    /** Charts' series colours, in order: twelve, each at least 3:1 on the paper. */
    chart: string[]
  }
  interface PaletteOptions {
    chart?: string[]
  }
}

export {}
