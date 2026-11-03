// shared/federation.ts — the modules the shell provides to plugin renderer remotes.
//
// Each is a Module Federation singleton: a plugin imports it normally, and at
// run time receives the shell's copy rather than bundling its own. The shell
// host (shell/renderer/views/federationViewLoader.ts) provides them, and the
// plugin build (scripts/build-plugins.mts) marks them shared and not bundled.
// The value is the version range a plugin built against this shell requires.
//
// Sharing is by exact specifier, so plugins import these from the package root
// only: `@mui/material`, never `@mui/material/Button`. A subpath would be
// bundled into the plugin as a second copy that cannot see the shell's theme.

export const SHARED_MODULES = {
  'react': '^18.2.0',
  'react/jsx-runtime': '^18.2.0',
  'react-dom': '^18.2.0',
  '@emotion/react': '^11.14.0',
  '@emotion/styled': '^11.14.0',
  '@mui/material': '^9.5.0',
  '@tessera/ui': '^0.1.0'
} as const satisfies Record<string, string>

export type SharedModule = keyof typeof SHARED_MODULES

export const SHARED_MODULE_NAMES = Object.keys(SHARED_MODULES) as SharedModule[]
