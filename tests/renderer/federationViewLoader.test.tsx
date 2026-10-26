import type { ViewDescriptor } from '@tessera/types'
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import * as React from 'react'
import { render, screen } from '@testing-library/react'
import { createFederationViewLoader } from '../../shell/renderer/views/federationViewLoader'
import { writeFakeRemote } from '../helpers/fakeRemote'
import { createTempModulesDir } from '../helpers/tempModules'

const view = (remoteEntry: string, extra: Partial<ViewDescriptor> = {}): ViewDescriptor => ({
  id: 'hello.view',
  title: 'Hello',
  slot: 'shell.main',
  module: './HelloView',
  pluginId: 'hello',
  remoteEntry,
  ...extra
})

describe('federation view loader', () => {
  it('loads an exposed component from a remote entry, sharing the host React', async () => {
    const entry = writeFakeRemote(path.join(createTempModulesDir(), 'hello'))

    const HelloView = await createFederationViewLoader().load(view(entry))
    render(<HelloView />)

    expect(screen.getByText('Hello from a federated plugin')).toBeInTheDocument()
    expect((globalThis as any).__remoteReact.useState).toBe(React.useState)
  })

  it('rejects modules without a default-exported component', async () => {
    const entry = writeFakeRemote(path.join(createTempModulesDir(), 'hello'))

    await expect(createFederationViewLoader().load(view(entry, { module: './NotAComponent' })))
      .rejects.toThrow('has no default-exported component')
  })

  it('surfaces errors for modules the remote does not expose', async () => {
    const entry = writeFakeRemote(path.join(createTempModulesDir(), 'hello'))

    await expect(createFederationViewLoader().load(view(entry, { module: './Missing' }))).rejects.toThrow()
  })
})
