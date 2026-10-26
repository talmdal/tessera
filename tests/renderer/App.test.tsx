import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { emptyLayout } from '../../shared/layout/types'
import App from '../../shell/renderer/App'
import { BarItemsProvider } from '../../shell/renderer/layout/BarItemsProvider'
import { ShellStateProvider } from '../../shell/renderer/state/ShellState'
import { ViewsProvider } from '../../shell/renderer/views/ViewsProvider'

/** A bridge answering the shell's state requests with an empty application. */
const bridge = {
  invoke: vi.fn(async (channel: string) => {
    if (channel === 'shell:lifecycle.get') return 'started'
    if (channel === 'shell:contextKeys.snapshot') return {}
    if (channel === 'shell:layout.get') return emptyLayout(7)
    throw new Error(`Unexpected request ${channel}`)
  }),
  on: vi.fn(() => () => {})
} as any

describe('renderer', () => {
  it('shows the welcome content when no plugin contributes to the main slot', async () => {
    render(
      <ShellStateProvider bridge={bridge}>
        <ViewsProvider source={{ listViews: async () => [] }} loader={{ load: async () => () => null }}>
          <BarItemsProvider source={{ listItems: async () => [] }}>
            <App />
          </BarItemsProvider>
        </ViewsProvider>
      </ShellStateProvider>
    )

    expect(await screen.findByText(/Tessera/i)).toBeInTheDocument()
    expect(screen.getByText(/Renderer shell is running/i)).toBeInTheDocument()
  })
})
