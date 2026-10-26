import type { ViewDescriptor } from '@tessera/types'
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { render, screen } from '@testing-library/react'
import { createFederationViewLoader } from '../../shell/renderer/views/federationViewLoader'
import { createTempModulesDir } from '../helpers/tempModules'

const repo = path.resolve(__dirname, '../..')

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
    render(<HelloView />)

    expect(screen.getByText('Hello from TSX')).toBeInTheDocument()   // rendering with hooks proves one shared React
    expect(await screen.findByText('Backend says: hello from the backend')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('sample-builtin:hello')
  })
})
