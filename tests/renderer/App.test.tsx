import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from '../../shell/renderer/App'

describe('renderer', () => {
  it('renders', () => {
    render(<App />)
    expect(screen.getByText(/Tessera/i)).toBeInTheDocument()
    expect(screen.getByText(/Renderer shell is running/i)).toBeInTheDocument()
  })
})
