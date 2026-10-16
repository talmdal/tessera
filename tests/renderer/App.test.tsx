import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from '../../shell/renderer/App'
import { ViewsProvider } from '../../shell/renderer/views/ViewsProvider'

describe('renderer', () => {
  it('shows the welcome content when no plugin contributes to the main slot', async () => {
    render(
      <ViewsProvider source={{ listViews: async () => [] }} loader={{ load: async () => () => null }}>
        <App />
      </ViewsProvider>
    )

    expect(await screen.findByText(/Tessera/i)).toBeInTheDocument()
    expect(screen.getByText(/Renderer shell is running/i)).toBeInTheDocument()
  })
})
