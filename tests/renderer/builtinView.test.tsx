import { describe, it, expect, vi, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { render, screen } from '@testing-library/react'
import type { ViewDescriptor } from '../../shared/views/types'
import { ShellThemeProvider } from '../../shell/renderer/theme/ShellThemeProvider'
import { createFederationViewLoader } from '../../shell/renderer/views/federationViewLoader'
import { createTempModulesDir } from '../helpers/tempModules'

const repo = path.resolve(__dirname, '../..')

// Loading the built remote (and MUI, the first time) through federation under jsdom takes seconds under load.
vi.setConfig({ testTimeout: 30_000 })

// Builds the fixture's TSX with the real build command (in its own Node
// process, since Vite's build can't run inside jsdom), then loads the generated
// remote through the shell's own view loader and renders it.
describe('a built-in plugin view built from TSX', () => {
  const out = createTempModulesDir()

  beforeAll(() => {
    execFileSync(process.execPath, [
      path.join(repo, 'node_modules/ts-node/dist/bin-esm.js'), '--transpile-only', path.join(repo, 'scripts/build-plugins.mts'),
      '--src', path.join(repo, 'tests/fixtures/plugins'), '--out', out
    ], { cwd: repo, stdio: 'pipe' })
  }, 90_000)

  it('loads with the shell\'s React and calls the plugin backend through window.api', async () => {
    const invoke = vi.fn(async () => 'hello from the backend')
    ;(window as any).api = { invoke }
    const view: ViewDescriptor = {
      id: 'sample-builtin.hello', title: 'Hello', slot: 'shell.main', module: './HelloView', pluginId: 'sample-builtin',
      remoteEntry: pathToFileURL(path.join(out, 'sample-builtin/renderer/remoteEntry.js')).href
    }

    const HelloView = await createFederationViewLoader().load(view)
    render(<ShellThemeProvider mode="dark"><HelloView /></ShellThemeProvider>)

    expect(screen.getByText('Hello from TSX')).toBeInTheDocument()   // rendering with hooks proves one shared React
    expect(await screen.findByText('Backend says: hello from the backend')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('sample-builtin:hello')
  })

  it('sees the shell\'s theme through the shared @mui/material and @tessera/ui', async () => {
    ;(window as any).api = { invoke: vi.fn(async () => 'hi') }
    const view: ViewDescriptor = {
      id: 'sample-builtin.hello', title: 'Hello', slot: 'shell.main', module: './HelloView', pluginId: 'sample-builtin',
      remoteEntry: pathToFileURL(path.join(out, 'sample-builtin/renderer/remoteEntry.js')).href
    }

    const HelloView = await createFederationViewLoader().load(view)
    const { container } = render(<ShellThemeProvider mode="dark"><HelloView /></ShellThemeProvider>)

    await screen.findByText('Backend says: hi')     // let the view's own fetch settle

    // useTheme in the remote returns the shell's theme: the mode the provider chose and the shell's tokens.
    expect(screen.getByText('Theme mode: dark')).toBeInTheDocument()
    expect(screen.getByText(/^Credit colour: #/)).toBeInTheDocument()
    // The Icon from @tessera/ui drew a Material glyph.
    expect(container.querySelector('svg[data-icon="Save"]')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })
})
