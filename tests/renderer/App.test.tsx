import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EMPTY_LAYOUT, LAYOUT_GET } from '../../shared/layout/types'
import App from '../../shell/renderer/App'
import { BarItemsProvider } from '../../shell/renderer/layout/BarItemsProvider'
import { ShellStateProvider } from '../../shell/renderer/state/ShellState'
import { ViewsProvider } from '../../shell/renderer/views/ViewsProvider'

const bridge = {
  invoke: async (channel: string) => channel === LAYOUT_GET ? { ...EMPTY_LAYOUT, windowId: 1 } : undefined,
  on: () => () => {}
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
