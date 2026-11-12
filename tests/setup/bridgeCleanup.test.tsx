// The fake privileged side (`window.api`) outlives what a test rendered: setupTests.ts unmounts first, then removes it.
// Unmounting runs a component's effect cleanups, and any effects still pending (an answer that arrived late), and
// either may call `window.api`. When a test file removed it in its own afterEach, which runs before setupTests'
// cleanup, the Restore dialog's pending plan request threw "Cannot read properties of undefined (reading 'invoke')" on
// a machine where it came late. The pending case depends on timing, so this test uses a cleanup, which always runs at
// unmount: it fails every time if `window.api` is removed first. A `window.api` that was there before a test (the
// preload exposes its own once, for its whole file) is put back, not removed.
import { useEffect } from 'react'
import { render, screen } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn(async () => undefined)

function Tells() {
  useEffect(() => () => { void window.api.invoke('test:closed') }, [])
  return <p>open</p>
}

describe('window.api, as a test ends', () => {
  it('is still there while what the test rendered is unmounted', () => {
    ;(window as unknown as { api: unknown }).api = { invoke }
    render(<Tells />)
    expect(screen.getByText('open')).toBeInTheDocument()
  })

  it('was reached as the previous test was cleaned up, and is gone afterwards', () => {
    expect(invoke).toHaveBeenCalledWith('test:closed')
    expect((window as unknown as { api?: unknown }).api).toBeUndefined()
  })
})

describe('a window.api there before the tests, as the preload exposes it', () => {
  const preloaded = { invoke: vi.fn(async () => undefined) }
  beforeAll(() => { (window as unknown as { api: unknown }).api = preloaded })
  afterAll(() => { delete (window as unknown as { api?: unknown }).api })

  it('may be replaced by a test…', () => {
    ;(window as unknown as { api: unknown }).api = { invoke }
    render(<Tells />)
  })

  it('…and is put back afterwards, not removed', () => {
    expect((window as unknown as { api?: unknown }).api).toBe(preloaded)
  })
})
